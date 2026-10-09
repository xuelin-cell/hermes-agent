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

另有一个只读的 ``activity``：定时任务和对话回合忙不忙、下一个定时任务几点到，
入口据此决定回收与定时叫醒。

只用标准库；以 hermes 用户（UID 10000）运行；归档当作不可信输入解压。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
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
# 变化检测忽略（相对 HERMES_HOME；profiles/<名字>/ 下同样的路径也算）：每用一次技能就改写的使用记录，
# 定时任务调度线程每分钟写一次的心跳 —— 都不代表用户状态变了。不忽略心跳的话，开着的实例什么都没做
# 也会每个归档周期打一份包（10-09 本机实测：空闲 75 秒内只有这两个心跳文件在变）。
NOISE_FILES = frozenset({
    "skills/.usage.json",
    "cron/ticker_heartbeat", "cron/ticker_last_success", "cron/ticker_last_error",
})
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


def _is_noise_file(rel: str) -> bool:
    if rel in NOISE_FILES:
        return True
    parts = rel.split("/", 2)
    return len(parts) == 3 and parts[0] == "profiles" and parts[2] in NOISE_FILES


def signature(home: Path) -> str:
    """状态签名：普通文件的 (路径, 大小, mtime) + 每个库的内容摘要。两次相同就说明没在变。"""
    files, dbs = collect(home)
    h = hashlib.sha256()
    for rel in files:
        if _is_noise_file(str(rel).replace(os.sep, "/")):
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

def wait_volume_writable(vol: Path, timeout_s: float, poll_s: float = 1.0) -> bool:
    """等卷对本用户可写。

    删旧实例和建新实例之间，节点上旧的卷挂载可能还没卸干净；新实例这时看到的 /mnt/u
    是一个 root 的空挂载点，不是 s3fs。它过一会儿可能会好，也可能这台实例一直就是坏的。
    这里只负责等；等不到由调用方报错，入口会把这台实例删掉换一台。
    """
    deadline = time.monotonic() + max(0.0, timeout_s)
    while True:
        if os.access(vol, os.W_OK):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(poll_s)


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


# ---------------------------------------------------------------- config.yaml 的平台块
#
# 10-08 真机事故：hermes 自己保存过的 config.yaml 里 base_url 被折成两行（值里混进了第二个 URL，
# PyYAML 遇到带空格的长值就折行）。旧版「按行改平台四行」只换了第一行、留下残行，整份文件不再合法，
# hermes 按默认配置启动，用户看到首次设置向导、"No inference provider configured"。
# 现在：整份解析 → 改平台块 → 回写 → 自检能解析。解析不了的先剔残行；还不行就按入口给的模板重建。
# 默认模型保留用户自己选的（只要它在套餐清单里），其余平台行以入口下发的为准。

NOTE_REBUILT = "config.yaml 无法解析，已按平台模板重建（用户自己的设置丢失）"

_KEY_LINE_RE = re.compile(r"^[^\s#\-][^:]*:(\s|$)")
_QUOTED_VALUE_LINE_RE = re.compile(r"""^(\s*)[^\s#\-][^:]*:\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*$""")


def strip_orphan_continuations(text: str) -> tuple[str, int]:
    """剔除「闭合的引号标量之后、缩进更深、既不像键也不像列表项或注释」的行。返回 (新文本, 剔了几行)。"""
    out: list[str] = []
    dropped = 0
    quoted_indent: int | None = None
    for ln in text.splitlines(keepends=True):
        body = ln.rstrip("\r\n")
        stripped = body.strip()
        indent = len(body) - len(body.lstrip(" "))
        if (quoted_indent is not None and stripped and indent > quoted_indent
                and not stripped.startswith("#") and not stripped.startswith("- ")
                and not _KEY_LINE_RE.match(stripped)):
            dropped += 1
            continue
        m = _QUOTED_VALUE_LINE_RE.match(body)
        quoted_indent = len(m.group(1)) if m else None
        out.append(ln)
    return "".join(out), dropped


def _yaml_io():
    """返回 (load, dump)。优先 ruamel 往返模式：保留注释与引号，和 hermes 自己 save_config_value 的写法一致；
    没有 ruamel（本地测试）就用 PyYAML。两种都把折行宽度放大，长值永远在一行上。"""
    try:
        from ruamel.yaml import YAML
    except ImportError:
        import yaml

        def load(text: str):
            return yaml.safe_load(text)

        def dump(obj) -> str:
            return yaml.safe_dump(obj, default_flow_style=False, allow_unicode=True, sort_keys=False, width=4096)

        return load, dump

    rt = YAML(typ="rt")
    rt.preserve_quotes = True
    rt.width = 4096

    def load_rt(text: str):
        import io
        return rt.load(io.StringIO(text))

    def dump_rt(obj) -> str:
        import io
        buf = io.StringIO()
        rt.dump(obj, buf)
        return buf.getvalue()

    return load_rt, dump_rt


def _check_parses(text: str) -> None:
    """自检：PyYAML（hermes 读配置用的库）必须能把它解析成映射。"""
    import yaml
    doc = yaml.safe_load(text) if text.strip() else {}
    if not isinstance(doc, dict):
        raise ValueError("config.yaml 顶层不是映射")


def _set_top(cfg, key: str, value) -> None:
    """顶层新增一段；ruamel 的映射放到 _config_version 后面，别甩在文件末尾。"""
    insert = getattr(cfg, "insert", None)
    if callable(insert):
        insert(1 if "_config_version" in cfg else 0, key, value)
    else:
        cfg[key] = value


def _platform_snapshot(cfg, key: str) -> str:
    """平台管的那几段，序列化成字符串好比较改没改。"""
    model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    providers = cfg.get("providers") if isinstance(cfg.get("providers"), dict) else {}
    agent = cfg.get("agent") if isinstance(cfg.get("agent"), dict) else {}
    return json.dumps({
        "model": {k: model.get(k) for k in ("default", "provider", "base_url", "key_env")},
        "provider": providers.get(key),
        "model_catalog": cfg.get("model_catalog"),
        "security": cfg.get("security"),
        "reasoning_overrides": agent.get("reasoning_overrides"),
    }, sort_keys=True, default=str)


def _section(cfg, key: str):
    """顶层的一段映射；没有（或不是映射）就新建。"""
    node = cfg.get(key)
    if not isinstance(node, dict):
        node = {}
        if key in cfg:
            cfg[key] = node
        else:
            _set_top(cfg, key, node)
    return node


def _norm_model(name: object) -> str:
    """模型名的宽松写法归一：大小写、点 / 横线、提供方前缀都不算区别（hermes 自己匹配时也这么宽）。"""
    return str(name).strip().lower().rsplit("/", 1)[-1].replace(".", "-")


def _apply_policy(cfg, policy: dict) -> None:
    """平台策略，两层：{段: {键: 值}}。每次引导都按平台的写，比如关在线模型目录、关临时装包。"""
    for top, leaves in policy.items():
        if isinstance(leaves, dict) and leaves:
            section = _section(cfg, str(top))
            for leaf, value in leaves.items():
                section[str(leaf)] = value


def _apply_reasoning_defaults(cfg, defaults: dict) -> None:
    """按模型预设推理强度：只补用户没设过的模型，用户自己写过的（任何写法）不动。"""
    defaults = {str(m).strip(): str(e).strip() for m, e in defaults.items() if str(m).strip() and str(e).strip()}
    if not defaults:
        return
    agent = _section(cfg, "agent")
    overrides = agent.get("reasoning_overrides")
    if not isinstance(overrides, dict):
        overrides = {}
        agent["reasoning_overrides"] = overrides
    have = {_norm_model(k) for k in overrides}
    for model, effort in defaults.items():
        if _norm_model(model) not in have:
            overrides[model] = effort


def _model_entry(name: str, limits: dict) -> dict:
    """providers.<key>.models 里每个模型的元数据：套餐给了上下文长度就写上，hermes 按它决定什么时候压缩。"""
    value = limits.get(name)
    return {"context_length": int(value)} if isinstance(value, int) and not isinstance(value, bool) and value > 0 else {}


def apply_platform_block(cfg, spec: dict) -> bool:
    """把入口下发的平台块写进解析后的配置。返回有没有改动。

    平台归平台：model 段的 provider / base_url / key_env，providers.<key> 整块（端点、key 来源、模型清单
    和每个模型的上下文长度），以及平台策略（policy，如关在线模型目录、关临时装包）。
    用户归用户：model.default 保留他自己选的，只要在套餐清单里；推理强度预设只补他没设过的模型；
    别的段一概不碰。
    """
    key = str(spec.get("provider_key", "")).strip()
    base_url = str(spec.get("base_url", "")).strip()
    plan_model = str(spec.get("model", "")).strip()
    key_env = str(spec.get("key_env", "")).strip()
    names = [str(n).strip() for n in (spec.get("models") or []) if str(n).strip()]
    limits = spec.get("limits") if isinstance(spec.get("limits"), dict) else {}
    before = _platform_snapshot(cfg, key)

    model = cfg.get("model")
    if not isinstance(model, dict):
        prev = model.strip() if isinstance(model, str) else ""
        model = {}
        if prev:
            model["default"] = prev
        _set_top(cfg, "model", model)
    current = str(model.get("default") or "").strip()
    allowed = names or ([plan_model] if plan_model else [])
    chosen = current if (current and current in allowed) else (plan_model or current)
    if chosen:
        model["default"] = chosen
    if key:
        model["provider"] = key
    if base_url:
        model["base_url"] = base_url
    if key_env:
        model["key_env"] = key_env

    if key:
        providers = cfg.get("providers")
        if not isinstance(providers, dict):
            providers = {}
            _set_top(cfg, "providers", providers)
        entry = providers.get(key)
        if not isinstance(entry, dict):
            entry = {}
            providers[key] = entry
        if base_url:
            entry["api"] = base_url
        if key_env:
            entry["key_env"] = key_env
        entry.setdefault("transport", "chat_completions")
        if plan_model:
            entry["default_model"] = plan_model
        if names:
            entry["models"] = {n: _model_entry(n, limits) for n in names}
        elif not isinstance(entry.get("models"), dict) or not entry["models"]:
            entry["models"] = {chosen: _model_entry(chosen, limits)} if chosen else {}
    if isinstance(spec.get("policy"), dict):
        _apply_policy(cfg, spec["policy"])
    if isinstance(spec.get("reasoning_defaults"), dict):
        _apply_reasoning_defaults(cfg, spec["reasoning_defaults"])
    return _platform_snapshot(cfg, key) != before


def patch_config_text(text: str, spec: dict) -> tuple[str, list[str]]:
    """返回 (新文本, 说明列表)。说明为空 = 没有改动，新文本就是原文。"""
    notes: list[str] = []
    load, dump = _yaml_io()
    cfg = None
    try:
        cfg = load(text) if text.strip() else {}
    except Exception:  # noqa: BLE001 —— 解析错误；库不同异常类型不同，统一按"解析不了"处理
        repaired, dropped = strip_orphan_continuations(text)
        if dropped:
            try:
                cfg = load(repaired)
                text = repaired
                notes.append(f"config.yaml 解析失败，剔除 {dropped} 行残行后恢复")
            except Exception:  # noqa: BLE001
                cfg = None
    if not isinstance(cfg, dict):
        template = str(spec.get("template") or "")
        if not template.strip():
            raise ValueError("config.yaml 无法解析，且入口没有给模板，不能重建")
        cfg = load(template)
        text = template
        notes = [NOTE_REBUILT]
    changed = apply_platform_block(cfg, spec)
    if not changed and not notes:
        return text, []
    if changed and not notes:
        notes.append("config.yaml 的平台行已更新")
    new_text = dump(cfg)
    _check_parses(new_text)
    return new_text, notes


def patch_config_file(path: Path, spec: dict) -> list[str]:
    """按入口给的 {base_url, model, provider_key, key_env, models, template} 改 config.yaml。返回说明（空 = 没改）。"""
    if path.is_file():
        text = path.read_text(encoding="utf-8")
        prefix: list[str] = []
    else:
        template = str(spec.get("template") or "")
        if not template.strip():
            return []
        text = template
        prefix = ["config.yaml 不存在，已按平台模板新建"]
    new_text, notes = patch_config_text(text, spec)
    if not notes and not prefix:
        return []
    _write_atomic(path, new_text.encode("utf-8"))
    return prefix + notes


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


# ---------------------------------------------------------------- 忙不忙：定时任务与对话回合
#
# 入口回收空闲实例前、暂停和删实例时要知道：现在有没有活在干，下一个定时任务几点到。
# 只读 hermes 自己写的文件，不改它：
#   定时任务 <home>/cron/jobs.json —— 下次执行时间 next_run_at（带时区的 ISO 串）；正在跑的任务
#            带 fire_claim，hermes 每 60 秒续一次、租约 300 秒，跑完清掉。调度线程每转一轮写一次
#            cron/ticker_heartbeat（epoch 秒）。
#   对话回合 <home>/state.db 的 sessions —— 回合进行中 hermes 每 30~60 秒写一次 last_activity_at，
#            同时带 last_activity_description；回合结束把描述清空。
# profiles/ 下每个没删的 profile 各有一套，hermes 的调度线程也是逐个转的。

CRON_CLAIM_TTL_S = 300.0   # 与 hermes claim_job_for_fire 的租约一致
TURN_ACTIVE_S = 300.0      # 回合心跳最慢 60 秒一次；5 分钟没动静就不算在跑
_PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def hermes_homes(home: Path) -> list[Path]:
    """默认 profile 加 profiles/ 下每个没删的 profile（删掉的在 profiles/.deleted/ 下留墓碑）。"""
    homes = [home]
    root = home / "profiles"
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return homes
    for entry in entries:
        if (entry.is_dir() and not entry.is_symlink() and entry.name != "default"
                and _PROFILE_NAME_RE.match(entry.name) and not (root / ".deleted" / entry.name).exists()):
            homes.append(entry)
    return homes


def _epoch(value) -> float | None:
    """hermes 写的时间 → epoch 秒。数字原样；ISO 串不带时区的按本机时区算（与 hermes 的 _ensure_aware 一致）。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).strip()).timestamp()
    except ValueError:
        return None


def _read_jobs(path: Path) -> list[dict]:
    """与 hermes load_jobs 同样宽容：BOM、裸控制字符、按 ID 当键的写法都认。"""
    raw = path.read_text(encoding="utf-8-sig")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = json.loads(raw, strict=False)
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    if not isinstance(jobs, list):
        raise ValueError("jobs 不是列表")
    return [job for job in jobs if isinstance(job, dict)]


def _job_will_run(job: dict) -> bool:
    """没启用、暂停了、已完成的任务不会再跑（与 hermes is_job_runnable 加终态判断一致）。"""
    if not job.get("enabled", True) or job.get("paused_at"):
        return False
    return str(job.get("state") or "").strip() not in ("paused", "completed")


def cron_activity(home: Path, now: float | None = None) -> dict:
    """``{"next_at": 最早的下次执行时间（epoch 秒）或 None, "running": 正在跑的任务数, "jobs": 还会再跑的任务数, "errors": [...]}``

    已经过点、而调度线程在那之后又转过一轮还没挪走它的任务（hermes 不肯跑它）不算进 next_at，
    免得入口为一个永远不会跑的任务反复叫醒实例。实例暂停期间调度线程不转，恢复后过点的任务照常算待跑。
    """
    now = time.time() if now is None else now
    next_at: float | None = None
    running = will_run = 0
    errors: list[str] = []
    for store in hermes_homes(home):
        cron_dir = store / "cron"
        jobs_file = cron_dir / "jobs.json"
        if not jobs_file.is_file():
            continue
        try:
            jobs = _read_jobs(jobs_file)
        except (OSError, ValueError) as exc:
            errors.append(f"{jobs_file.relative_to(home)}: {type(exc).__name__}")
            continue
        try:
            ticked_at: float | None = float((cron_dir / "ticker_heartbeat").read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            ticked_at = None
        for job in jobs:
            claim = job.get("fire_claim")
            claimed_at = _epoch(claim.get("at")) if isinstance(claim, dict) else None
            if claimed_at is not None and 0 <= now - claimed_at < CRON_CLAIM_TTL_S:
                running += 1
            if not _job_will_run(job):
                continue
            will_run += 1
            due = _epoch(job.get("next_run_at"))
            if due is None or (ticked_at is not None and due < ticked_at - 5):
                continue
            next_at = due if next_at is None else min(next_at, due)
    return {"next_at": next_at, "running": running, "jobs": will_run, "errors": errors}


def turn_activity(home: Path, now: float | None = None) -> dict:
    """``{"running": 进行中的对话回合数, "errors": [...]}``。只读打开各 profile 的 state.db。"""
    now = time.time() if now is None else now
    running = 0
    errors: list[str] = []
    for store in hermes_homes(home):
        db = store / "state.db"
        if not db.is_file():
            continue
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2.0)
            try:
                row = conn.execute(
                    "SELECT COUNT(*) FROM sessions WHERE COALESCE(last_activity_description, '') <> '' "
                    "AND last_activity_at >= ?",
                    (now - TURN_ACTIVE_S,),
                ).fetchone()
            finally:
                conn.close()
            running += int(row[0] or 0)
        except sqlite3.Error as exc:
            errors.append(f"{db.relative_to(home)}: {type(exc).__name__}")
    return {"running": running, "errors": errors}


def activity(home: Path, now: float | None = None) -> dict:
    """转发器随 /__mt/status、sync、drain 回报给入口的「忙不忙」。读不了的部分记进 errors，不抛。"""
    now = time.time() if now is None else now
    cron = cron_activity(home, now)
    turns = turn_activity(home, now)
    return {
        "checked_at": now,
        "cron_next_at": cron["next_at"],
        "cron_running": cron["running"],
        "cron_jobs": cron["jobs"],
        "turns": turns["running"],
        "errors": cron["errors"] + turns["errors"],
    }


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
                 require_mount: bool = True, vol_wait_s: float = 90.0):
        self.home = Path(home)
        self.vol = Path(vol)
        self.owner = owner
        self.epoch = int(epoch)
        self.require_mount = require_mount  # 测试里卷只是个普通目录
        self.vol_wait_s = vol_wait_s        # 卷不可写时最多等这么久（新实例挂卷有延迟）
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
        if not wait_volume_writable(self.vol, self.vol_wait_s):
            raise StateError(f"卷 {self.vol} 等了 {self.vol_wait_s:.0f}s 仍对本用户不可写（挂载还没就绪或属主不对），拒绝启动")
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
            rep.notes.extend(patch_config_file(self.home / "config.yaml", config_patch))

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
