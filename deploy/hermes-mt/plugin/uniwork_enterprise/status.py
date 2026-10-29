"""插件的状态文件 ``<主目录>/.cache/uniwork-enterprise/plugin-status.json``，排查用（网页终端里 cat 它）：

    {"profiles": [加载了插件的 profile 目录…], "headers": 加过会话头的模型请求数,
     "lastSend": {"at": 时间, "code": 状态码（-1 = 连不上）, "sent": 条数}, "queued": 还没发的条数, "updated": 时间}

hermes 加载第二个 profile 时偶尔会因为并发报 ``dictionary changed size during iteration``，挂掉的插件每次不同；
轮到这个插件时，那个 profile 不会出现在 profiles 里。不含令牌、参数和正文。
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from .settings import STATUS_FILE, write_json_atomic

WRITE_EVERY_S = 5.0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Status:
    def __init__(self, root: Path):
        self.path = Path(root) / STATUS_FILE
        self._lock = threading.Lock()
        self._profiles: list[str] = []
        self._headers = 0
        self._last_send: dict | None = None
        self._queued = 0
        self._written = 0.0

    def note_profile(self, home: Path) -> None:
        with self._lock:
            name = str(home)
            if name not in self._profiles:
                self._profiles.append(name)
        self.write(force=True)

    def note_headers(self) -> None:
        with self._lock:
            self._headers += 1
        self.write()

    def note_send(self, code: int, sent: int, queued: int) -> None:
        with self._lock:
            self._last_send = {"at": _now(), "code": int(code), "sent": int(sent)}
            self._queued = int(queued)
        self.write(force=True)

    def write(self, *, force: bool = False) -> None:
        with self._lock:
            now = time.monotonic()
            if not force and now - self._written < WRITE_EVERY_S:
                return
            self._written = now
            payload = {"profiles": list(self._profiles), "headers": self._headers, "lastSend": self._last_send,
                       "queued": self._queued, "updated": _now()}
        write_json_atomic(self.path, payload)
