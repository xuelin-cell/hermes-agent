"""状态管家：在实例可写层（块存储，只跑不存）和用户的 S3 卷（唯一持久）之间搬运状态。

职责只有三件，都由 forward.py 调用：

1. **引导恢复** ``prepare``：拉起 hermes 之前，把上一代实例留在卷上的归档恢复到
   本地盘，校验通过、写好主人标记、建好目录链接，才允许启动 hermes。任何一步
   不对就抛错停下 —— hermes 遇到全零的库会静默换成空库，用户看到的就是历史全没了，
   所以这里绝不能"尽力而为"。
2. **定时归档** ``archive``：把本地盘上的全部 SQLite 库（用在线备份接口拷出一致快照）
   和状态文件打成一个 tar.gz，连同清单放到卷上 ``.state/e<编号>-<实例ID>/`` 下。
   有实质改动才做；hermes 每分钟写一次心跳、每用一次技能改一次使用记录，这两类不算改动。
3. **主人标记** ``OWNER``：每台实例只写自己那一代的目录，写之前核对卷上的 OWNER 是不是
   自己 —— 不是就说明入口已经把这个用户交给了新实例，本实例必须停止写卷。

只用标准库；以 hermes 用户（UID 10000）运行；归档当作不可信输入解压。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

SQLITE_MAGIC = b"SQLite format 3\x00"
STATE_DIRNAME = ".state"
OWNER_FILE = "OWNER"
LATEST_FILE = "LATEST"
PARENT_FILE = "PARENT"
MANIFEST_VERSION = 1

# 解压上限：归档是我们自己写的，但卷对实例内的 agent 完全可写，只能当不可信输入。
MAX_MEMBER_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024

# 卷内布局：hermes 看到的路径不变，用目录链接指进卷里。
# ★ 历史会话里记的是 /opt/data/images/... 这样的原始路径，已有的链接定了就不能再改，只能往后加。
# 后三条是 agent 用工具生成的图片 / 音频 / 视频：hermes 写在 cache/ 下（image_gen_provider、
# video_gen_provider、tts_tool），放进 workspace/uploads/media/ 之下是因为仪表盘 /api/media
# 只肯读 images/、screenshots/、cache/ 这几个根（都按 resolve 后的真实路径比），
# 链到 images 根的下面它才认。hermes 网关进程每小时清理 cache/* 里超过 24 小时的文件，
# 我们的实例只跑 hermes serve、没有网关进程，所以这里不会被清。
LINKS: tuple[tuple[str, str], ...] = (
    ("workspace", "workspace"),
    ("attachments", "workspace/uploads/attachments"),
    ("images", "workspace/uploads/media"),
    ("cache/images", "workspace/uploads/media/generated/images"),
    ("cache/audio", "workspace/uploads/media/generated/audio"),
    ("cache/videos", "workspace/uploads/media/generated/videos"),
)

# 归档排除（相对 HERMES_HOME 的顶层名）：卷本身、三条链接、日志缓存临时物、运行态文件。
EXCLUDE_TOP = frozenset({
    "workspace", "attachments", "images", "scratch",
    "logs", "cache", "lazy-packages", "node", "bin", "lsp",
    "state-snapshots", "backups", "checkpoints", "sandboxes",
    "browser-profile", "browser-profiles", "browser_recordings",
    "telemetry", "terminal-sessions", "pastes", "moa-traces",
    "profile-exports", "skill-bundles",
    ".cache", ".local", ".npm", ".config", ".mt", ".vol",
    "spawn-ledger.json", "processes.json", "gateway.pid", "gateway.lock",
    "gateway_state.json", "cron.pid", ".backup.lock", ".skills_prompt_snapshot.json",
})
# 任意层级都跳过的目录名。
EXCLUDE_DIR_NAMES = frozenset({"__pycache__", "node_modules", ".venv", "venv", ".git", ".tox", "site-packages"})
# home/ 是终端子进程的 HOME，只收白名单里的小配置（相对 home/）。
HOME_KEEP = (".gitconfig", ".ssh", ".npmrc", ".pypirc", ".netrc", ".config/git")
# 变化检测忽略（相对 HERMES_HOME）：每用一次技能就改写，不代表用户状态变了。
NOISE_FILES = frozenset({"skills/.usage.json"})
# 库里不算变化的表：hermes 每分钟写一次心跳；FTS 影子表随主表变。
NOISE_TABLES = frozenset({"gateway_heartbeats"})


class StateError(RuntimeError):
    """状态管家的失败都用这个抛出；forward.py 把 message 原样回给入口。"""


class RefuseStart(StateError):
    """卷上的状态说明不该以入口给的参数启动（PG 丢了、回滚了、或没给恢复来源）。"""


class OwnerLost(StateError):
    """卷上的 OWNER 已经不是本实例：入口把用户交给了新实例，本实例必须停止写卷。"""


def _utc_stamp(now: float | None = None) -> str:
    return datetime.fromtimestamp(now if now is not None else time.time(), tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _parse_stamp(name: str) -> datetime | None:
    try:
        return datetime.strptime(name[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_atomic(path: Path, data: bytes) -> None:
    """先写临时名再改名。s3fs 上 rename 是复制加删除，不原子，但目标对象是整体出现的。"""
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _copy_atomic(src: Path, dst: Path) -> None:
    tmp = dst.with_name(dst.name + ".tmp")
    with open(src, "rb") as fi, open(tmp, "wb") as fo:
        shutil.copyfileobj(fi, fo, 1024 * 1024)
        fo.flush()
        os.fsync(fo.fileno())
    os.replace(tmp, dst)


def is_sqlite(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(len(SQLITE_MAGIC)) == SQLITE_MAGIC
    except OSError:
        return False


# ---------------------------------------------------------------- SQLite

def snapshot_db(src: Path, dst: Path, timeout_s: float = 20.0) -> None:
    """用在线备份接口拷一份一致的库。直接 cp 正在用的库会丢掉还在 -wal 里的最近事务。"""
    src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=0.0)
    dst_conn = sqlite3.connect(str(dst))
    deadline = time.monotonic() + timeout_s

    def progress(status: int, remaining: int, total: int) -> None:
        nonlocal deadline
        if status in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
            if time.monotonic() >= deadline:
                raise StateError(f"{src.name} 一直被锁着，{timeout_s:g}s 内拷不出一致快照")
        else:
            deadline = time.monotonic() + timeout_s

    try:
        src_conn.backup(dst_conn, pages=256, progress=progress, sleep=0.05)
    except sqlite3.Error as exc:
        raise StateError(f"备份 {src.name} 失败: {exc}") from exc
    finally:
        dst_conn.close()
        src_conn.close()


def _user_tables(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
    return [r[0] for r in rows if "_fts" not in r[0]]


def db_counts(path: Path) -> dict[str, int]:
    """每张用户表的行数（去掉心跳表和 FTS 影子表）。写进清单，恢复后用来比对。"""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5.0)
    try:
        out: dict[str, int] = {}
        for name in _user_tables(conn):
            if name in NOISE_TABLES:
                continue
            out[name] = int(conn.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0])
        return out
    finally:
        conn.close()


def db_signature(path: Path) -> str:
    """一个能反映「用户可见内容变没变」的摘要：每表 (行数, 最大 rowid)，心跳表不算。"""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5.0)
    try:
        parts: list[str] = []
        for name in _user_tables(conn):
            if name in NOISE_TABLES:
                continue
            count = conn.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
            try:
                top = conn.execute(f'SELECT max(rowid) FROM "{name}"').fetchone()[0]
            except sqlite3.Error:
                top = None
            parts.append(f"{name}:{count}:{top}")
        return hashlib.sha256("\n".join(parts).encode()).hexdigest()
    except sqlite3.Error as exc:
        # 库正在被改结构或暂时锁着：把异常文本当签名，下一轮自然会不同。
        return f"err:{type(exc).__name__}"
    finally:
        conn.close()


def verify_db(path: Path, expected_counts: dict[str, int] | None = None) -> None:
    """恢复后的自检：文件头、quick_check、行数与清单一致。不过就抛错，绝不放 hermes 去猜。"""
    if not is_sqlite(path):
        raise StateError(f"{path.name} 不是 SQLite 文件（文件头不对，可能是全零文件）")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5.0)
    try:
        result = conn.execute("PRAGMA quick_check").fetchone()
        if not result or result[0] != "ok":
            raise StateError(f"{path.name} 完整性检查未通过: {result}")
    except sqlite3.Error as exc:
        raise StateError(f"{path.name} 打不开: {exc}") from exc
    finally:
        conn.close()
    if expected_counts:
        actual = db_counts(path)
        for table, want in expected_counts.items():
            got = actual.get(table)
            if got != want:
                raise StateError(f"{path.name} 表 {table} 行数 {got} 与清单 {want} 不一致")


def _sidecars(db: Path) -> list[Path]:
    return [db.with_name(db.name + suffix) for suffix in ("-wal", "-shm", "-journal")]


# ---------------------------------------------------------------- 收集

def _is_noise_name(name: str) -> bool:
    return name.endswith((".tmp", ".lock", ".bak")) or ".bak-" in name or ".malformed-backup-" in name or "_cache." in name


def _home_keep_dir(sub: str) -> bool:
    """home/ 下的目录：是白名单项本身、它的子目录、或它的上级目录，才往里走。"""
    return any(sub == k or sub.startswith(k + "/") or k.startswith(sub + "/") for k in HOME_KEEP)


def _home_keep_file(sub: str) -> bool:
    return any(sub == k or sub.startswith(k + "/") for k in HOME_KEEP)


def collect(home: Path) -> tuple[list[Path], list[Path]]:
    """返回 (普通状态文件, SQLite 库)，都是相对 home 的路径。不跨挂载点，不进排除目录，不跟链接。"""
    files: list[Path] = []
    dbs: list[Path] = []
    home_dev = home.stat().st_dev
    for root, dirnames, filenames in os.walk(home):
        rel_root = Path(root).relative_to(home)
        parts = rel_root.parts
        top = parts[0] if parts else ""
        keep_dirs: list[str] = []
        for d in dirnames:
            p = Path(root) / d
            if p.is_symlink() or d in EXCLUDE_DIR_NAMES:
                continue
            if not parts and d in EXCLUDE_TOP:
                continue
            try:
                if p.stat().st_dev != home_dev:  # 挂载点：卷或别的什么，不是本地盘
                    continue
            except OSError:
                continue
            if top == "home" and not _home_keep_dir("/".join(parts[1:] + (d,))):
                continue
            keep_dirs.append(d)
        dirnames[:] = keep_dirs
        for fn in filenames:
            p = Path(root) / fn
            if not parts and fn in EXCLUDE_TOP:
                continue
            if p.is_symlink() or _is_noise_name(fn):
                continue
            if top == "home" and not _home_keep_file("/".join(parts[1:] + (fn,))):
                continue
            if top == "sessions" and fn.startswith("request_dump_"):
                continue
            if fn.endswith(("-wal", "-shm", "-journal")) and (Path(root) / fn.rsplit("-", 1)[0]).exists():
                continue
            try:
                if not p.is_file():
                    continue
            except OSError:
                continue
            (dbs if is_sqlite(p) else files).append(rel_root / fn)
    files.sort()
    dbs.sort()
    return files, dbs


def signature(home: Path) -> str:
    """状态签名：普通文件的 (路径, 大小, mtime) + 每个库的内容摘要。两次相同就说明没在变。"""
    files, dbs = collect(home)
    h = hashlib.sha256()
    for rel in files:
        if str(rel).replace(os.sep, "/") in NOISE_FILES:
            continue
        try:
            st = (home / rel).stat()
        except OSError:
            continue
        h.update(f"{rel}|{st.st_size}|{st.st_mtime_ns}\n".encode())
    for rel in dbs:
        h.update(f"{rel}|{db_signature(home / rel)}\n".encode())
    return h.hexdigest()


def skills_busy(home: Path) -> bool:
    """技能正在升级（同步器先把旧目录挪成 .bak）时打包会把半截技能固化下来。"""
    skills = home / "skills"
    if not skills.is_dir():
        return False
    for root, dirnames, _ in os.walk(skills):
        if any(d.endswith(".bak") for d in dirnames):
            return True
    return False


# ---------------------------------------------------------------- 归档

@dataclass
class Manifest:
    owner: str
    epoch: int
    parent: str
    created_at: str
    archive: str
    size: int
    sha256: str
    files: int
    dbs: dict[str, dict[str, int]] = field(default_factory=dict)
    version: int = MANIFEST_VERSION

    def to_json(self) -> bytes:
        return json.dumps(self.__dict__, ensure_ascii=False, indent=1).encode("utf-8")

    @classmethod
    def from_json(cls, data: bytes) -> "Manifest":
        raw = json.loads(data.decode("utf-8"))
        return cls(
            owner=str(raw.get("owner", "")),
            epoch=int(raw.get("epoch", 0)),
            parent=str(raw.get("parent", "")),
            created_at=str(raw.get("created_at", "")),
            archive=str(raw.get("archive", "")),
            size=int(raw.get("size", 0)),
            sha256=str(raw.get("sha256", "")),
            files=int(raw.get("files", 0)),
            dbs={k: {t: int(n) for t, n in v.items()} for k, v in (raw.get("dbs") or {}).items()},
            version=int(raw.get("version", 1)),
        )

    def summary(self) -> dict:
        return {
            "owner": self.owner,
            "epoch": self.epoch,
            "archive": self.archive,
            "size": self.size,
            "sha256": self.sha256,
            "files": self.files,
            "created_at": self.created_at,
            "counts": {db: dict(t) for db, t in self.dbs.items()},
        }


def build_archive(home: Path, work: Path, owner: str, epoch: int, parent: str) -> tuple[Path, Manifest]:
    """在本地盘 *work* 下打一个 tar.gz，返回 (路径, 清单)。

    一致性：库用在线备份接口拷快照；普通文件按同一个文件句柄 fstat 再整读，
    文件在中途被原子替换时我们读到的仍是替换前那份完整内容，不会截断。
    """
    files, dbs = collect(home)
    stamp = _utc_stamp()
    name = f"{stamp}.tar.gz"
    tar_path = work / name
    snap_dir = work / "db"
    snap_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[str, dict[str, int]] = {}
    n_files = 0
    with tarfile.open(tar_path, "w:gz", compresslevel=6) as tar:
        for rel in dbs:
            snap = snap_dir / f"{len(counts)}.db"
            snapshot_db(home / rel, snap)
            counts[str(rel).replace(os.sep, "/")] = db_counts(snap)
            info = tar.gettarinfo(str(snap), arcname=str(rel).replace(os.sep, "/"))
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            with open(snap, "rb") as f:
                tar.addfile(info, f)
            snap.unlink()
            n_files += 1
        for rel in files:
            src = home / rel
            try:
                fd = os.open(src, os.O_RDONLY)
            except OSError:
                continue
            with os.fdopen(fd, "rb") as f:
                st = os.fstat(f.fileno())
                info = tarfile.TarInfo(str(rel).replace(os.sep, "/"))
                info.size = st.st_size
                info.mtime = int(st.st_mtime)
                info.mode = st.st_mode & 0o777
                tar.addfile(info, f)
            n_files += 1
    st = tar_path.stat()
    manifest = Manifest(
        owner=owner,
        epoch=epoch,
        parent=parent,
        created_at=stamp,
        archive=name,
        size=st.st_size,
        sha256=_sha256_file(tar_path),
        files=n_files,
        dbs=counts,
    )
    return tar_path, manifest


def gen_dirname(epoch: int, owner: str) -> str:
    return f"e{epoch:06d}-{owner}"


def select_keep(names: list[str], now: datetime | None = None) -> set[str]:
    """分层保留：最近 1 小时全留；之后每天留最新一份（7 天）；再往后每周一份（4 周）；最新一份永远留。"""
    now = now or datetime.now(timezone.utc)
    stamped = sorted(((n, _parse_stamp(n)) for n in names if _parse_stamp(n)), key=lambda x: x[1], reverse=True)
    keep: set[str] = set()
    if not stamped:
        return keep
    keep.add(stamped[0][0])
    per_day: dict[str, str] = {}
    per_week: dict[str, str] = {}
    for name, ts in stamped:
        age = now - ts
        if age <= timedelta(hours=1):
            keep.add(name)
        elif age <= timedelta(days=7):
            per_day.setdefault(ts.strftime("%Y%m%d"), name)
        elif age <= timedelta(days=28):
            per_week.setdefault(ts.strftime("%G%V"), name)
    keep.update(per_day.values())
    keep.update(per_week.values())
    return keep


# ---------------------------------------------------------------- 卷上的目录

@dataclass
class Owner:
    owner: str
    epoch: int


def read_owner(state_dir: Path) -> Owner | None:
    p = state_dir / OWNER_FILE
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        return Owner(owner=str(raw.get("owner", "")), epoch=int(raw.get("epoch", 0)))
    except (OSError, ValueError, TypeError):
        return None


def write_owner(state_dir: Path, owner: str, epoch: int) -> None:
    _write_atomic(state_dir / OWNER_FILE, json.dumps({"owner": owner, "epoch": epoch, "at": _utc_stamp()}).encode())


def find_gen_dir(state_dir: Path, owner: str) -> Path | None:
    if not owner or not state_dir.is_dir():
        return None
    matches = sorted(p for p in state_dir.iterdir() if p.is_dir() and p.name.endswith("-" + owner) and p.name.startswith("e"))
    return matches[-1] if matches else None


def read_parent(gen_dir: Path) -> str:
    try:
        return (gen_dir / PARENT_FILE).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _resolve_chain(state_dir: Path, owner: str, notes: list[str]) -> tuple[str, Path, Manifest] | None:
    """从 *owner* 这一代起，沿 PARENT 往前找到第一份真实存在的归档。找不到返回 None。"""
    seen: set[str] = set()
    cur = owner
    while cur and cur not in seen:
        seen.add(cur)
        gen = find_gen_dir(state_dir, cur)
        if gen is None:
            return None
        manifest = latest_manifest(gen)
        if manifest is not None:
            return cur, gen, manifest
        parent = read_parent(gen)
        if not parent:
            return None
        notes.append(f"{cur[:12]} 这一代没有归档，沿谱系退到 {parent[:12]}")
        cur = parent
    return None


def latest_manifest(gen_dir: Path) -> Manifest | None:
    try:
        name = (gen_dir / LATEST_FILE).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not name:
        return None
    try:
        manifest = Manifest.from_json((gen_dir / (name[: -len(".tar.gz")] + ".json")).read_bytes())
    except (OSError, ValueError):
        return None
    if manifest.archive != name or not (gen_dir / name).is_file():
        return None
    return manifest


# ---------------------------------------------------------------- 恢复

def _check_member(m: tarfile.TarInfo, total: int) -> int:
    name = m.name
    if name.startswith("/") or name.startswith("\\") or ".." in Path(name).parts or ":" in name.split("/")[0]:
        raise StateError(f"归档里有非法路径: {name!r}")
    if not (m.isreg() or m.isdir()):
        raise StateError(f"归档里有不允许的成员类型: {name!r}")
    if m.size > MAX_MEMBER_BYTES:
        raise StateError(f"归档成员过大: {name!r}")
    total += m.size
    if total > MAX_TOTAL_BYTES:
        raise StateError("归档总大小超过上限")
    return total


def restore_archive(home: Path, gen_dir: Path, manifest: Manifest) -> dict:
    """把归档解到本地盘并校验。返回 {"archive", "counts"}。失败抛 StateError，且不会留下半截。"""
    archive = gen_dir / manifest.archive
    if not archive.is_file():
        raise StateError(f"归档不存在: {archive.name}")
    if _sha256_file(archive) != manifest.sha256:
        raise StateError(f"归档 {archive.name} 的哈希与清单不符")
    tmp_root = Path(tempfile.mkdtemp(prefix=".restore-", dir=home))
    try:
        total = 0
        with tarfile.open(archive, "r:gz") as tar:
            members = []
            for m in tar:
                total = _check_member(m, total)
                members.append(m)
            tar.extractall(tmp_root, members=members, filter="data")
        # 顶层条目整体替换：模板里的默认 skills/ 等先删掉，用户删掉的内置技能才不会回来。
        for entry in sorted(tmp_root.iterdir(), key=lambda p: p.name):
            dest = home / entry.name
            if dest.is_symlink():
                continue  # 我们自己建的目录链接，永远不碰
            if dest.is_dir():
                shutil.rmtree(dest)
            elif dest.exists():
                dest.unlink()
            os.replace(entry, dest)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)
    for rel, counts in manifest.dbs.items():
        db = home / rel
        # 别的库残留的 -wal 会被 SQLite 当成这个库的日志回放，结果是 malformed 或旧行复活。
        for side in _sidecars(db):
            side.unlink(missing_ok=True)
        verify_db(db, counts)
        # 自检用的只读连接可能留下空的 -wal/-shm；此刻没人开着库，清掉最干净。
        for side in _sidecars(db):
            side.unlink(missing_ok=True)
    return {"archive": manifest.archive, "counts": {k: dict(v) for k, v in manifest.dbs.items()}}


# ---------------------------------------------------------------- 目录链接与布局

def ensure_layout(vol: Path) -> Path:
    try:
        for _, rel in LINKS:
            (vol / rel).mkdir(parents=True, exist_ok=True)
        state_dir = vol / STATE_DIRNAME
        state_dir.mkdir(exist_ok=True)
    except OSError as exc:
        raise StateError(f"卷 {vol} 对本用户不可写（挂载参数或属主不对）: {exc}") from exc
    return state_dir


def _link_points_to(link: Path, target: Path) -> bool:
    try:
        current = os.readlink(link)
    except OSError:
        return False
    if current.startswith("\\\\?\\"):  # Windows 的 readlink 会带 \\?\ 前缀（只影响本机跑测试）
        current = current[4:]
    return os.path.normcase(os.path.normpath(current)) == os.path.normcase(os.path.normpath(str(target)))


def ensure_links(home: Path, vol: Path) -> list[str]:
    """把 home 下的 workspace / attachments / images 做成指向卷内目录的链接。返回动过的项。"""
    changed: list[str] = []
    for name, rel in LINKS:
        target = vol / rel
        link = home / name
        if link.is_symlink():
            if _link_points_to(link, target):
                continue
            link.unlink()
        elif link.is_dir():
            # 老布局或模板里的空目录：把已有内容搬进卷，再换成链接。
            for child in list(link.iterdir()):
                dest = target / child.name
                if dest.exists():
                    dest = target / f"{child.name}.moved-{_utc_stamp()}"
                shutil.move(str(child), str(dest))
            link.rmdir()
        elif link.exists():
            raise StateError(f"{link} 不是目录也不是链接，不敢动")
        link.parent.mkdir(parents=True, exist_ok=True)  # cache/ 这种上级目录可能还不存在
        os.symlink(str(target), str(link))
        changed.append(name)
    return changed


# ---------------------------------------------------------------- .env 与 config.yaml 的平台行

def env_upsert(path: Path, lines: list[str]) -> None:
    """只改我们负责的几行（KEY=VALUE），其余保持用户自己的。"""
    wanted: dict[str, str] = {}
    for ln in lines:
        if "=" in ln and not ln.lstrip().startswith("#"):
            k, v = ln.split("=", 1)
            wanted[k.strip()] = v
    existing = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    out: list[str] = []
    seen: set[str] = set()
    for ln in existing:
        k = ln.split("=", 1)[0].strip() if "=" in ln and not ln.lstrip().startswith("#") else None
        if k in wanted:
            out.append(f"{k}={wanted[k]}")
            seen.add(k)
        else:
            out.append(ln)
    for k, v in wanted.items():
        if k not in seen:
            out.append(f"{k}={v}")
    _write_atomic(path, ("\n".join(out) + "\n").encode("utf-8"))
    try:
        path.chmod(0o600)
    except OSError:
        pass


def patch_config(text: str, base_url: str, model_name: str, provider_key: str) -> str:
    """只改 model: 段和 providers.<key>: 段里的端点/模型四行，其余一字不动。（与入口 Docker 路径同一份逻辑）"""
    out: list[str] = []
    section: str | None = None
    sub: str | None = None
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\n")
        if body and not body[0].isspace() and body.rstrip().endswith(":"):
            section = body.rstrip()[:-1]
            sub = None
        elif section == "providers" and body.startswith("  ") and not body.startswith("    ") and body.rstrip().endswith(":"):
            sub = body.strip()[:-1]
        stripped = body.strip()
        if section == "model" and stripped.startswith("base_url:"):
            line = f'  base_url: "{base_url}"\n'
        elif section == "model" and stripped.startswith("default:"):
            line = f'  default: "{model_name}"\n'
        elif section == "providers" and sub == provider_key and stripped.startswith("api:"):
            line = f'    api: "{base_url}"\n'
        elif section == "providers" and sub == provider_key and stripped.startswith("default_model:"):
            line = f'    default_model: "{model_name}"\n'
        out.append(line)
    return "".join(out)


def patch_models(text: str, provider_key: str, names: list[str]) -> str:
    """把 providers.<key>.models 整段换成 names；段不存在就补在该 provider 末尾。"""
    if not names:
        return text
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    section: str | None = None
    sub: str | None = None
    in_models = False
    wrote = False
    block = [f"      {n}: {{}}\n" for n in names]

    def flush_provider_end() -> None:
        nonlocal wrote
        if wrote:
            return
        trailing: list[str] = []
        while out and not out[-1].strip():
            trailing.append(out.pop())
        out.append("    models:\n")
        out.extend(block)
        out.extend(reversed(trailing))
        wrote = True

    for line in lines:
        body = line.rstrip("\n")
        top = bool(body) and not body[0].isspace() and body.rstrip().endswith(":")
        prov = section == "providers" and body.startswith("  ") and not body.startswith("    ") and body.rstrip().endswith(":")
        if in_models:
            if not body.strip() or not body.startswith("      "):
                in_models = False
            else:
                continue
        if top or prov:
            if sub == provider_key and (top or prov):
                flush_provider_end()
            section = body.rstrip()[:-1] if top else section
            sub = body.strip()[:-1] if prov else (None if top else sub)
        if section == "providers" and sub == provider_key and body.strip().startswith("models:"):
            out.append("    models:\n")
            out.extend(block)
            wrote = True
            in_models = True
            continue
        out.append(line)
    if sub == provider_key:
        flush_provider_end()
    return "".join(out)


def patch_config_file(path: Path, spec: dict) -> bool:
    """按入口给的 {base_url, model, provider_key, models} 改写 config.yaml 的平台行。返回是否改了。"""
    if not path.is_file():
        return False
    raw = path.read_text(encoding="utf-8")
    patched = patch_config(raw, str(spec.get("base_url", "")), str(spec.get("model", "")), str(spec.get("provider_key", "")))
    patched = patch_models(patched, str(spec.get("provider_key", "")), [str(n) for n in (spec.get("models") or [])])
    if patched == raw:
        return False
    _write_atomic(path, patched.encode("utf-8"))
    return True


def run_config_migration(home: Path, hermes_root: Path = Path("/opt/hermes")) -> str:
    """换镜像之后用户的 config.yaml 版本可能落后；serve 自己不迁移，只有容器启动脚本迁移。

    这里跟启动脚本一样跑 scripts/docker_config_migrate.py。它失败只告警，不挡启动。
    """
    script = hermes_root / "scripts" / "docker_config_migrate.py"
    python = hermes_root / ".venv" / "bin" / "python"
    if not (script.is_file() and python.is_file() and (home / "config.yaml").is_file()):
        return "skipped"
    env = dict(os.environ, HERMES_HOME=str(home))
    try:
        proc = subprocess.run([str(python), str(script)], cwd=str(hermes_root), env=env,
                              capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"failed: {type(exc).__name__}"
    if proc.returncode != 0:
        return "failed: " + (proc.stderr or proc.stdout).strip()[-300:]
    return "ok"


# ---------------------------------------------------------------- 管家本体

@dataclass
class Report:
    owner: str
    epoch: int
    restored_from: str = ""
    archive: str = ""
    counts: dict = field(default_factory=dict)
    links: list[str] = field(default_factory=list)
    migration: str = ""
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return dict(self.__dict__)


class StateManager:
    """一台实例一个。``prepare`` 在拉起 hermes 之前调；``archive`` 由定时循环和接口调。"""

    def __init__(self, home: Path, vol: Path, owner: str, epoch: int, work: Path | None = None,
                 require_mount: bool = True):
        self.home = Path(home)
        self.vol = Path(vol)
        self.owner = owner
        self.epoch = int(epoch)
        self.require_mount = require_mount  # 测试里卷只是个普通目录
        self.work = Path(work) if work else self.home / ".mt" / "work"
        self.state_dir = self.vol / STATE_DIRNAME
        self.gen_dir = self.state_dir / gen_dirname(self.epoch, self.owner)
        self.parent = ""
        self.last_manifest: Manifest | None = None
        self.last_archive_at: float = 0.0
        self.last_error: str = ""
        self.last_signature: str = ""
        self.archives = 0
        self.phase = "new"
        self._lock = threading.Lock()  # 定时归档、sync、drain 共用：同一时刻只打一个包

    # ---- 状态 ------------------------------------------------------------
    def status(self) -> dict:
        try:
            usage = shutil.disk_usage(self.home)
            free = {"free_bytes": usage.free, "used_pct": round(100 * usage.used / max(1, usage.total), 1)}
        except OSError:
            free = {}
        return {
            "phase": self.phase,
            "owner": self.owner,
            "epoch": self.epoch,
            "gen_dir": self.gen_dir.name,
            "restored_from": self.parent,
            "last_archive": self.last_manifest.archive if self.last_manifest else "",
            "last_archive_at": self.last_archive_at,
            "archives": self.archives,
            "last_error": self.last_error,
            "writable_layer": free,
        }

    # ---- 引导 ------------------------------------------------------------
    def prepare(self, restore_from: str, force: bool = False, expect_epoch: int | None = None,
                seed_env_lines: list[str] | None = None, config_patch: dict | None = None,
                migrate: bool = True) -> Report:
        self.phase = "restoring"
        rep = Report(owner=self.owner, epoch=self.epoch)
        if self.require_mount and not os.path.ismount(self.vol):
            raise StateError(f"卷没有挂在 {self.vol}（不是挂载点），拒绝启动：否则归档会写进本地空目录")
        state_dir = ensure_layout(self.vol)
        current = read_owner(state_dir)

        # 以谁为准：卷上的 OWNER 编号必须小于我们这一代，否则说明入口那边的记录倒退了。
        if current is not None:
            if current.epoch >= self.epoch and not force:
                raise RefuseStart(
                    f"卷上的主人是 {current.owner[:12]}（编号 {current.epoch}），不小于本实例编号 {self.epoch}："
                    "入口的记录可能丢失或回滚，拒绝以更旧的来源启动。确认后可带 force 重试")
            if not restore_from and not force:
                raise RefuseStart(
                    f"卷上已有主人 {current.owner[:12]}（编号 {current.epoch}）但入口没给恢复来源，拒绝以空库启动")

        # 候选来源按优先级：卷上的 OWNER（上一代引导成功但入口没记上时它比入口给的新）→ 入口给的。
        # 每个候选沿 PARENT 链往前找到第一份真实存在的归档：一代实例可能还没来得及归档就没了。
        candidates: list[str] = []
        if current is not None and current.owner not in (restore_from, self.owner):
            candidates.append(current.owner)
        if restore_from:
            candidates.append(restore_from)
        resolved: tuple[str, Path, Manifest] | None = None
        for cand in candidates:
            resolved = _resolve_chain(state_dir, cand, rep.notes)
            if resolved is not None:
                if cand != restore_from:
                    rep.notes.append(f"卷上的主人 {cand[:12]} 比入口给的来源新，改从它这一支恢复")
                break

        if resolved is None and restore_from:
            gen = find_gen_dir(state_dir, restore_from)
            if gen is None and current is None:
                rep.notes.append(f"来源 {restore_from[:12]} 在卷上没有目录，按新用户启动")
            elif not force:
                raise StateError(f"来源 {restore_from[:12]} 这一支没有任何可用的归档，拒绝以空库启动")
            else:
                rep.notes.append(f"来源 {restore_from[:12]} 没有归档，force 之下按空库启动")
        if resolved is not None:
            source_owner, gen, manifest = resolved
            result = restore_archive(self.home, gen, manifest)
            rep.restored_from = source_owner
            rep.archive = result["archive"]
            rep.counts = result["counts"]
            self.parent = source_owner
        self._seed(rep, seed_env_lines, config_patch, migrate)
        rep.links = ensure_links(self.home, self.vol)
        (self.home / "scratch").mkdir(exist_ok=True)
        self.gen_dir.mkdir(parents=True, exist_ok=True)
        # 先记谱系再记主人：本代还没归档就没了时，下一代能沿着 PARENT 找到更早的归档。
        _write_atomic(self.gen_dir / PARENT_FILE, self.parent.encode())
        write_owner(state_dir, self.owner, self.epoch)
        self.last_signature = ""
        self.phase = "ready"
        return rep

    def _seed(self, rep: Report, env_lines: list[str] | None, config_patch: dict | None, migrate: bool) -> None:
        if migrate:
            rep.migration = run_config_migration(self.home)
        if env_lines:
            env_upsert(self.home / ".env", env_lines)
        if config_patch:
            if patch_config_file(self.home / "config.yaml", config_patch):
                rep.notes.append("config.yaml 的平台行已更新")

    # ---- 归档 ------------------------------------------------------------
    def owner_ok(self) -> bool:
        current = read_owner(self.state_dir)
        return current is not None and current.owner == self.owner

    def archive(self, force: bool = False) -> Manifest | None:
        """有实质改动时打一份归档到卷上。返回清单；没变化或技能升级中返回 None。"""
        with self._lock:
            return self._archive(force)

    def _archive(self, force: bool) -> Manifest | None:
        if not self.owner_ok():
            self.phase = "fenced"
            raise OwnerLost("卷上的 OWNER 已不是本实例，停止写卷")
        if not force and skills_busy(self.home):
            return None
        sig = signature(self.home)
        if not force and sig == self.last_signature:
            return None
        if not force:
            time.sleep(1.5)  # 两次扫描一致才动手，避开正在写的瞬间
            again = signature(self.home)
            if again != sig:
                return None
        self.phase = "archiving"
        work = self.work
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True, exist_ok=True)
        try:
            tar_path, manifest = build_archive(self.home, work, self.owner, self.epoch, self.parent)
            self.gen_dir.mkdir(parents=True, exist_ok=True)
            if not self.owner_ok():
                self.phase = "fenced"
                raise OwnerLost("打包期间卷上的 OWNER 变了，丢弃这份归档")
            _copy_atomic(tar_path, self.gen_dir / manifest.archive)
            _write_atomic(self.gen_dir / (manifest.created_at + ".json"), manifest.to_json())
            _write_atomic(self.gen_dir / LATEST_FILE, manifest.archive.encode())
            self.last_manifest = manifest
            self.last_archive_at = time.time()
            self.last_signature = sig if not force else signature(self.home)
            self.archives += 1
            self.last_error = ""
            self._prune()
            self.phase = "ready"
            return manifest
        except Exception as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
            self.phase = "ready" if not isinstance(exc, OwnerLost) else "fenced"
            raise
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _prune(self) -> None:
        """只清理本实例自己这一代的旧归档；别代的目录归入口管。"""
        try:
            names = [p.name for p in self.gen_dir.iterdir() if p.name.endswith(".tar.gz")]
        except OSError:
            return
        keep = select_keep(names)
        if self.last_manifest:
            keep.add(self.last_manifest.archive)
        for name in names:
            if name in keep:
                continue
            for p in (self.gen_dir / name, self.gen_dir / (name[: -len(".tar.gz")] + ".json")):
                try:
                    p.unlink()
                except OSError:
                    pass
