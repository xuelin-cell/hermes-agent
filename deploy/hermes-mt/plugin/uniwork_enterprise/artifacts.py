"""产物上传（docs/企业版对接 27 号第 4 节、29 号第 3 节）：Agent 这一轮交给员工的文件，传到平台的「产物管理」。

选哪些（认路径的写法照 hermes 自带的 desktop-deliverables 插件，plugins/desktop-deliverables/paths.py）：
- 最终回复里点名的文件：MEDIA: 行、Markdown 链接、引号和反引号里的路径、绝对路径、文件名；
- 平台发起的运行（``platform == "api_server"``，没人看回复里的卡片）另外加上这一轮 write_file、patch 写出的；
- 都要满足：真实路径在工作区里（/opt/data/workspace 是指向卷的链接，按解开后的比）、扩展名在交付白名单里、
  不在点开头的目录和素材目录里、不是员工上传的附件、非空、不超过 100MB、这一轮开始以后建的或改过的。
  每轮最多 8 个，文档排前面。子代理的回复是交给主 agent 的，不算。
怎么传：multipart ``POST /api/client/artifacts``（file、sessionId、sessionName、agentId；成员自己的对话 agentId 留空）。
平台按（会话、文件名、sha256）去重，重传没关系；本地也记着传过的（会话、路径、大小、修改时间），没变就不再传。
待传清单写在 .cache/uniwork-enterprise/artifacts-pending.json，实例重启后接着传；24 小时还没传出去就丢。
返回码：2xx（含成员在屏蔽名单里时的 ``{"skipped": true}``）算完；401 重读令牌再试一次，还不行歇 1 分钟；
403 清空、歇 5 分钟；404 歇 1 小时；400、413、422 丢掉这一个；429、5xx、连不上退避重试。
开关：plugin.json 的 ``artifacts``（平台策略 policy.artifacts.enabled）；关着时攒着的也清掉。
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import stat
import threading
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .outbox import (BACKOFF_MAX_S, BACKOFF_MIN_S, CLIENT_VERSION, FORBIDDEN_PAUSE_S, MISSING_PAUSE_S, NETWORK_ERROR,
                     NO_TOKEN, UNAUTHORIZED_PAUSE_S)
from .settings import write_json_atomic

log = logging.getLogger("uniwork_enterprise")

PATH = "/api/client/artifacts"
PENDING_FILE = ".cache/uniwork-enterprise/artifacts-pending.json"
MAX_BYTES = 100 * 1024 * 1024  # 平台 artifacts.MAX_ARTIFACT
PER_TURN = 8
FLUSH_S = 5.0
MAX_AGE_S = 24 * 3600
QUEUE_LIMIT = 200
SEEN_LIMIT = 1000
UPLOAD_TIMEOUT_S = 300.0
GONE = -2  # 文件没了、变成目录、变得太大：丢掉这一个

# ---------------------------------------------------------------- 选文件（照 desktop-deliverables/paths.py）

EXTENSIONS = {"docx", "doc", "xlsx", "xls", "pptx", "ppt", "pdf", "md", "html", "htm", "csv", "png", "jpg", "jpeg",
              "gif", "webp", "svg", "mp3", "wav", "m4a", "mp4", "mov", "webm", "zip"}
EXCLUDED = {"node_modules", ".git", "__pycache__", "venv", ".venv", "site-packages", "themes", "templates",
            "references", "scripts", "assets", "examples"}
DOCUMENTS = {"docx", "doc", "xlsx", "xls", "pptx", "ppt", "pdf"}
IMAGES = {"png", "jpg", "jpeg", "gif", "webp", "svg"}
ATTACHMENTS = ("uploads", "attachments")  # 员工上传的附件（seed/mtstate.py 的目录表），不是产物
_EXT = "|".join(sorted(EXTENSIONS))
_ROOT = r"(?<![\w:/\\.])(?:/?[A-Za-z]:[\\/]|~[\\/]|/(?![/\\]))"
_STOP = r"\s\"'<>|*?`，。；：！？、（）()【】\[\]{}"
_ABSOLUTE = re.compile(_ROOT + "[^" + _STOP + "]+?" + r"\.(?:" + _EXT + r")(?![A-Za-z0-9])", re.I)
_BARE = re.compile(r"(?<![\w./\\-])([\w.-]+\.(?:" + _EXT + r"))(?![A-Za-z0-9])", re.I)
_QUOTED = re.compile(r"`([^`\n]+)`|\"([^\"\n]+)\"|'([^'\n]+)'|\]\(<?([^)>\n]+)>?\)")
_LINE_END = re.compile(r"\.(?:" + _EXT + r")$", re.I)
MEDIA = re.compile(r"^[ \t]*MEDIA:[ \t]*(`[^`\n]+`|\"[^\"\n]+\"|'[^'\n]+'|\S+)[ \t]*(?:\r?\n|$)", re.M)
MAX_FOLDERS = 8


def resolve_path(value, cwd: Path) -> Path | None:
    """只解析本机路径；URL、UNC 和设备路径不算。相对路径按 ``cwd``。"""
    if not isinstance(value, str):
        return None
    raw = value.strip().strip("`\"'").rstrip(".,;!?，。；！？")
    if raw.startswith("file://"):
        parsed = urlsplit(raw)
        if parsed.netloc not in {"", "localhost"}:
            return None
        raw = unquote(parsed.path)
    if os.name == "nt":
        raw = re.sub(r"^/([A-Za-z]:[/\\])", r"\1", raw)
    if not raw or "://" in raw or raw.startswith(("\\\\", "//")):
        return None
    try:
        path = Path(raw).expanduser()
        return path if path.is_absolute() else Path(cwd) / path
    except (OSError, ValueError):
        return None


def _is_dir(path: Path) -> bool:
    try:
        return path.is_dir()
    except (OSError, ValueError):
        return False


def named_paths(text, cwd: Path, folders=()) -> list[Path]:
    """回复里点到的路径：引号里的、整行是路径的、MEDIA: 行、绝对路径，以及在 ``cwd``、``folders`` 和回复里
    提到的目录下的文件名。不遍历目录猜文件。"""
    text = text[:200_000] if isinstance(text, str) else ""
    quoted = [next(value for value in match.groups() if value is not None) for match in _QUOTED.finditer(text)]
    complete_lines = [line for line in text.splitlines() if _LINE_END.search(line)]
    paths = [resolve_path(value, cwd)
             for value in quoted + complete_lines + [match.group(1) for match in MEDIA.finditer(text)]]
    places = list(dict.fromkeys([Path(cwd), *(Path(f) for f in folders)]))
    for path in paths:
        if len(places) >= MAX_FOLDERS:
            break
        if path and path not in places and _is_dir(path):
            places.append(path)
    paths += [resolve_path(match.group(), cwd) for match in _ABSOLUTE.finditer(text)]
    paths += [place / match.group(1) for match in _BARE.finditer(text) for place in places]
    return list(dict.fromkeys(path for path in paths if path is not None))


def hidden(parts) -> bool:
    """路径片段里有点开头的目录、文件，或素材目录名：不算交付。"""
    return any(part.startswith(".") or part.lower() in EXCLUDED for part in parts)


def deliverable(real: Path, workspace: Path, since: float, max_bytes: int = MAX_BYTES) -> bool:
    """``real`` 是解开链接后的路径，``workspace`` 也是。"""
    try:
        parts = real.relative_to(workspace).parts
    except ValueError:
        return False
    if not parts or hidden(parts) or parts[-1].startswith("~$") or tuple(p.lower() for p in parts[:2]) == ATTACHMENTS:
        return False
    if real.suffix.lower().lstrip(".") not in EXTENSIONS:
        return False
    try:
        st = real.stat()
    except (OSError, ValueError):
        return False
    if not stat.S_ISREG(st.st_mode) or not 0 < st.st_size <= max_bytes:
        return False
    # 时间只容忍两秒时钟偏差（和桌面端一样）
    return max(st.st_mtime, getattr(st, "st_birthtime", 0)) >= since - 2


def priority(path: Path) -> int:
    """文档、文本、图片、音视频依次排，同类按点名的先后。"""
    extension = path.suffix.lower().lstrip(".")
    if extension in DOCUMENTS:
        return 0
    if extension in {"md", "html", "htm", "csv", "zip"}:
        return 1
    return 2 if extension in IMAGES else 3


def pick(paths, *, workspace: Path, since: float, limit: int = PER_TURN) -> list[Path]:
    """候选路径 → 这一轮要传的文件（解开链接后的路径，去重、排序、最多 ``limit`` 个）。"""
    try:
        root = Path(os.path.realpath(workspace))
    except (OSError, ValueError):
        return []
    chosen: list[Path] = []
    seen: set[Path] = set()
    for path in paths:
        try:
            real = Path(os.path.realpath(path))
        except (OSError, ValueError):
            continue
        if real in seen:
            continue
        seen.add(real)
        if deliverable(real, root, since):
            chosen.append(real)
    chosen.sort(key=priority)
    return chosen[:limit]


def workspace_of(root: Path) -> Path:
    """工作区：文件面板的根（沙箱镜像的 HERMES_DASHBOARD_FILES_ROOT），没设就是 <主目录>/workspace。"""
    return Path(os.environ.get("HERMES_DASHBOARD_FILES_ROOT") or Path(root) / "workspace")


def turn_cwd(task_id: str, fallback: Path) -> Path:
    """相对路径和文件名按哪个目录找：对话登记的工作目录，其次终端当前目录，都没有就是工作区。"""
    try:
        from tools.terminal_tool import _get_env_config, get_session_cwd, resolve_task_overrides

        if _get_env_config().get("env_type") == "local":
            for raw in (resolve_task_overrides(task_id).get("cwd"), get_session_cwd(task_id)):
                if isinstance(raw, str) and raw.strip() and _is_dir(Path(raw)):
                    return Path(raw)
    except Exception:  # noqa: BLE001 —— 测试环境没有 hermes，或终端还没起
        pass
    return Path(fallback)


# ---------------------------------------------------------------- 上传


def http_upload(url: str, fields: dict, file: tuple, headers: dict, timeout: float) -> int:
    import httpx

    return httpx.post(url, data=fields, files={"file": file}, headers=headers,
                      timeout=httpx.Timeout(timeout, connect=15.0)).status_code


def _seen_key(session: str, path: str, size: int, mtime_ns: int) -> str:
    return f"{session}\n{path}\n{size}\n{mtime_ns}"


class Uploader:
    """整个实例一个待传清单、一个后台线程（各 profile 用同一个成员的设备令牌、同一个平台）。"""

    def __init__(self, source, root: Path, *, status=None, post=http_upload, titles=None, clock=time.time,
                 monotonic=time.monotonic, background: bool = True):
        self.source = source
        self.root = Path(root)
        self.path = self.root / PENDING_FILE
        self.status = status
        self._post = post
        self._titles = titles  # (profile 名, 会话号) -> 标题
        self._clock = clock  # 入队时间要跨重启比，用墙上时间
        self._monotonic = monotonic
        self._background = background
        self._lock = threading.Lock()
        self._saving = threading.Lock()
        self._sending = threading.Lock()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._paused_until = 0.0
        self._backoff = 0.0
        self._items, self._seen = self._load()
        if self._items:
            self._ensure_thread()

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)

    # ---- 清单

    def _load(self) -> tuple[list[dict], list[str]]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return [], []
        if not isinstance(raw, dict):
            return [], []
        items = [i for i in raw.get("items") or [] if isinstance(i, dict) and i.get("path") and i.get("sessionId")]
        seen = [s for s in raw.get("seen") or [] if isinstance(s, str)]
        return items[-QUEUE_LIMIT:], seen[-SEEN_LIMIT:]

    def _save(self) -> None:
        # 取快照和写盘一起排队：入队（钩子线程）和传完（后台线程）同时存时，后写的一定是后取的快照
        with self._saving:
            with self._lock:
                payload = {"v": 1, "items": list(self._items), "seen": list(self._seen)}
            write_json_atomic(self.path, payload)

    def put(self, paths, *, session: str, root: str, profile: str, agent_id: str) -> int:
        """这一轮选出的文件入队；传过而且没变的、已经在队里的不重复入队。返回入队几个。"""
        added = 0
        now = self._clock()
        with self._lock:
            queued = {item.get("key") for item in self._items}
            for path in paths:
                try:
                    st = Path(path).stat()
                except OSError:
                    continue
                key = _seen_key(root, str(path), st.st_size, st.st_mtime_ns)
                if key in queued or key in self._seen:
                    continue
                queued.add(key)
                self._items.append({"key": key, "path": str(path), "sessionId": root, "session": session,
                                    "profile": profile, "agentId": agent_id, "queuedAt": now})
                added += 1
            del self._items[:-QUEUE_LIMIT]
        if added:
            self._save()
            self._ensure_thread()
            self._wake.set()
        return added

    def kick(self) -> None:
        with self._lock:
            pending = bool(self._items)
        if pending:
            self._ensure_thread()
            self._wake.set()

    def _finish(self, item: dict, *, key: str | None) -> None:
        """这一个处理完了（传上去了，或者丢掉）；传上去的记进「传过的」。"""
        with self._lock:
            self._items = [i for i in self._items if i is not item]
            if key:
                self._seen.append(key)
                del self._seen[:-SEEN_LIMIT]
        self._save()

    # ---- 后台

    def _ensure_thread(self) -> None:
        if not self._background:
            return
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(target=self._run, name="uniwork-enterprise-artifacts", daemon=True)
            thread = self._thread
        thread.start()

    def _run(self) -> None:
        while True:
            self._wake.wait(FLUSH_S)
            self._wake.clear()
            try:
                self.flush()
            except Exception as exc:  # noqa: BLE001 —— 后台线程不能死
                log.debug("uniwork-enterprise: artifact upload failed: %s", type(exc).__name__)

    def _pause(self, seconds: float) -> None:
        self._paused_until = self._monotonic() + seconds

    def _title(self, item: dict) -> str:
        if self._titles is None:
            return ""
        try:
            return str(self._titles(str(item.get("profile") or "default"), str(item.get("session") or "")) or "")[:200]
        except Exception:  # noqa: BLE001
            return ""

    def _send(self, settings, item: dict) -> tuple[int, str | None]:
        """(状态码, 传上去时文件的「传过」标记)。"""
        path = Path(str(item.get("path")))
        try:
            handle = path.open("rb")
        except OSError:
            return GONE, None
        with handle:
            try:
                st = os.fstat(handle.fileno())
            except OSError:
                return GONE, None
            if not stat.S_ISREG(st.st_mode) or not 0 < st.st_size <= MAX_BYTES:
                return GONE, None
            key = _seen_key(str(item.get("sessionId")), str(path), st.st_size, st.st_mtime_ns)
            fields = {"sessionId": str(item.get("sessionId") or ""), "sessionName": self._title(item),
                      "agentId": str(item.get("agentId") or "")}
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            url = settings.server + PATH
            for attempt in (0, 1):
                token = self.source.token(settings.token_env, force=attempt == 1)
                if not token:
                    return NO_TOKEN, None
                headers = {"Authorization": f"Bearer {token}", "X-Uniwork-Version": CLIENT_VERSION}
                try:
                    handle.seek(0)
                    code = int(self._post(url, fields, (path.name, handle, content_type), headers, UPLOAD_TIMEOUT_S))
                except Exception:  # noqa: BLE001 —— 连不上、超时、读文件出错：退避重试
                    return NETWORK_ERROR, None
                if code != 401:
                    return code, key
            return 401, None

    def flush(self) -> int:
        """传到清单空、出错或该歇着为止；返回这次传上去几个。"""
        sent = 0
        with self._sending:
            while True:
                if self._monotonic() < self._paused_until:
                    return sent
                settings = self.source.settings()
                now = self._clock()
                with self._lock:
                    before = len(self._items)
                    self._items = [i for i in self._items if now - float(i.get("queuedAt") or 0) <= MAX_AGE_S]
                    if not settings.enabled or not settings.artifacts:
                        self._items = []
                    changed = len(self._items) != before
                    item = self._items[0] if self._items else None
                if changed:
                    self._save()
                if item is None:
                    return sent
                code, key = self._send(settings, item)
                if 200 <= code < 300:
                    self._finish(item, key=key)
                    self._backoff = 0.0
                    sent += 1
                    self._note(code, 1)
                    continue
                if code in (GONE, 400, 413, 422):
                    self._finish(item, key=None)
                    self._note(code, 0)
                    continue
                if code in (401, NO_TOKEN):
                    self._pause(UNAUTHORIZED_PAUSE_S)
                elif code == 403:
                    with self._lock:
                        self._items = []
                    self._save()
                    self._pause(FORBIDDEN_PAUSE_S)
                elif code == 404:
                    self._pause(MISSING_PAUSE_S)
                else:
                    self._backoff = min(BACKOFF_MAX_S, max(BACKOFF_MIN_S, self._backoff * 2))
                    self._pause(self._backoff)
                self._note(code, 0)
                log.info("uniwork-enterprise: artifact upload got %s; %d queued", code, len(self))
                return sent

    def _note(self, code: int, sent: int) -> None:
        if self.status is not None:
            self.status.note_artifacts(code, sent, len(self))


# ---------------------------------------------------------------- 钩子


def _text(value) -> str:
    return value if isinstance(value, str) else ""


def make_write_hook(turns, workspace: Path):
    """``post_tool_call``：平台发起的运行里，记下这一轮 write_file、patch 写了哪些文件。"""

    def uniwork_artifact_writes(tool_name="", args=None, status=None, session_id="", turn_id="", task_id="",
                                **_kwargs):
        try:
            if tool_name not in ("write_file", "patch") or str(status or "ok") != "ok" or not session_id:
                return None
            turn = turns.current(str(session_id), str(turn_id or ""))
            if turn is None or turn.platform != "api_server" or not isinstance(args, dict):
                return None
            path = resolve_path(args.get("path"), turn_cwd(str(task_id or turn.task_id), workspace))
            if path is not None:
                turns.note_write(str(session_id), str(turn_id or ""), str(path))
        except Exception as exc:  # noqa: BLE001
            log.debug("uniwork-enterprise: artifact write not recorded: %s", type(exc).__name__)
        return None

    return uniwork_artifact_writes


def make_turn_hook(source, roots, turns, uploader, profile: str, workspace: Path):
    """``post_llm_call``：一轮结束，按最终回复选出这一轮的产物入队。"""

    def uniwork_artifacts(session_id="", turn_id="", task_id="", assistant_response=None, platform="", **_kwargs):
        try:
            turn = turns.end(str(session_id or ""), str(turn_id or ""))
            settings = source.settings()
            if turn is None or not settings.enabled or not settings.artifacts or not session_id:
                return None
            platform = str(platform or turn.platform or "")
            if platform == "subagent":
                return None
            cwd = turn_cwd(str(task_id or turn.task_id), workspace)
            paths = named_paths(_text(assistant_response), cwd, (workspace,))
            if platform == "api_server":
                paths = [Path(p) for p in turn.writes] + paths
            chosen = pick(paths, workspace=workspace, since=turn.started)
            if chosen:
                uploader.put(chosen, session=str(session_id), root=roots.root(str(session_id)), profile=profile,
                             agent_id=settings.profile(profile).agent_id)
        except Exception as exc:  # noqa: BLE001
            log.debug("uniwork-enterprise: artifacts skipped: %s", type(exc).__name__)
        return None

    return uniwork_artifacts
