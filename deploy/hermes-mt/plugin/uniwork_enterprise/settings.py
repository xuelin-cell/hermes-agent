"""插件的配置：转发器写的 plugin.json，和实例的设备令牌。

``plugin.json`` 在实例主目录（/opt/data）的 ``.cache/uniwork-enterprise/`` 下，seed/mtent.py 每次装企业清单时写::

    {"v": 1, "enabled": true, "server": "<平台地址>", "tokenEnv": "<令牌变量名>", "toolAudit": true}

不含令牌。没有这个文件（个人模式、清单还没送到）或 ``enabled`` 为假，插件什么都不做。按修改时间缓存，
入口改了开关、平台改了 toolAudit，下一次用到时就生效，不用重启 hermes。

设备令牌只从主目录的 .env 读：入口重新登录换令牌只改这一份，转发器再同步给其他 profile。同样按修改时间缓存。
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

CONFIG_FILE = ".cache/uniwork-enterprise/plugin.json"
STATUS_FILE = ".cache/uniwork-enterprise/plugin-status.json"


def root_of(home: Path) -> Path:
    """profile 的目录 → 实例主目录：员工自建的和平台下发的 Agent 都在 ``<主目录>/profiles/<名字>``。"""
    home = Path(home)
    return home.parent.parent if home.parent.name == "profiles" else home


def origin(url: str) -> tuple[str, str, int] | None:
    """(scheme, host, port)；写法不同的同一个地址（大小写、缺省端口、结尾斜杠）算同一个。"""
    try:
        parts = urlsplit(str(url or "").strip())
        port = parts.port or {"http": 80, "https": 443}.get(parts.scheme.lower(), 0)
    except ValueError:
        return None
    if not parts.scheme or not parts.hostname:
        return None
    return parts.scheme.lower(), parts.hostname.lower(), port


@dataclass(frozen=True)
class Settings:
    enabled: bool = False
    server: str = ""
    token_env: str = ""
    tool_audit: bool = False

    def is_platform(self, url: str) -> bool:
        """``url`` 是不是平台上的地址（模型请求只有发给平台时才带会话头）。"""
        mine = origin(self.server)
        return mine is not None and origin(url) == mine


OFF = Settings()


class _MtimeCache:
    """按 (修改时间, 大小) 缓存一个小文件的解析结果；文件不在就是 ``missing``。"""

    def __init__(self, missing):
        self._missing = missing
        self._key: tuple[int, int] | None = None
        self._value = missing
        self._lock = threading.Lock()

    def get(self, path: Path, parse, *, force: bool = False):
        try:
            st = path.stat()
        except OSError:
            with self._lock:
                self._key, self._value = None, self._missing
            return self._missing
        key = (st.st_mtime_ns, st.st_size)
        with self._lock:
            if not force and key == self._key:
                return self._value
        try:
            value = parse(path.read_bytes())
        except (OSError, ValueError, UnicodeDecodeError):
            value = self._missing
        with self._lock:
            self._key, self._value = key, value
        return value


def _parse_settings(data: bytes) -> Settings:
    raw = json.loads(data.decode("utf-8"))
    if not isinstance(raw, dict):
        return OFF
    server = str(raw.get("server") or "").rstrip("/")
    token_env = str(raw.get("tokenEnv") or "")
    enabled = raw.get("enabled") is True and bool(server) and bool(token_env)
    return Settings(enabled=enabled, server=server, token_env=token_env, tool_audit=raw.get("toolAudit") is True)


def _parse_env(data: bytes) -> dict[str, str]:
    """.env 的 ``KEY=VALUE`` 行（可带 ``export``、引号）；和 hermes、seed/mtent.env_value 的读法一致。"""
    out: dict[str, str] = {}
    for line in data.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key] = value
    return out


class Source:
    """一个实例主目录的配置和令牌（同一个进程里各个 profile 共用）。"""

    def __init__(self, root: Path):
        self.root = Path(root)
        self._settings = _MtimeCache(OFF)
        self._env = _MtimeCache({})

    def settings(self) -> Settings:
        return self._settings.get(self.root / CONFIG_FILE, _parse_settings)

    def token(self, name: str, *, force: bool = False) -> str:
        """设备令牌；``force`` 跳过缓存重读（平台回 401 时：可能刚换了令牌）。没有就回空串。"""
        if not name:
            return ""
        return str(self._env.get(self.root / ".env", _parse_env, force=force).get(name) or "")


def write_json_atomic(path: Path, payload: dict) -> None:
    """写小 JSON 文件：先写临时文件再改名，读的一方不会读到半份。失败就算了（只用于状态这类辅助信息）。"""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
