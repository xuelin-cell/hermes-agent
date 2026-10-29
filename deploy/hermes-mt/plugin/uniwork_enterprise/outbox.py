"""工具调用记录的发送：整个实例一个队列、一个后台线程（各 profile 用的是同一个成员的设备令牌、同一个平台）。

- 每 5 秒、攒满一批（200 条，14 号第 14 条）、或一轮对话结束时发一次。队列最多 2000 条，满了丢最旧的；
  6 小时还没发出去的也丢。只在内存里：实例重启时没发出去的就没了（桌面端也是这样）。
- 平台回 2xx：这一批发完。401：可能刚换了令牌，重读 .env 再试一次，还不行丢掉这一批、歇 1 分钟
  （.env 里暂时读不到令牌就只歇 1 分钟，不丢）。
  403（成员停用、没有权限）：清空队列，停 5 分钟。404（平台没有这个接口）：停 1 小时。
  400/413/422（这一批本身有问题）：丢掉这一批。429、5xx、连不上：退避重试，5 秒起、最长 5 分钟。
- plugin.json 关了插件或 toolAudit：攒着的也不发了，清空。
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque

log = logging.getLogger("uniwork_enterprise")

PATH = "/api/client/tool-calls"
CLIENT_VERSION = "hermes-cloud-plugin/1.0"
FLUSH_S = 5.0
BATCH = 200
QUEUE_LIMIT = 2000
MAX_AGE_S = 6 * 3600
TIMEOUT_S = 15.0
UNAUTHORIZED_PAUSE_S = 60.0
FORBIDDEN_PAUSE_S = 300.0
MISSING_PAUSE_S = 3600.0
BACKOFF_MIN_S = 5.0
BACKOFF_MAX_S = 300.0
NETWORK_ERROR = -1
NO_TOKEN = 0  # .env 里暂时没有令牌（正在换、还没同步）：歇 1 分钟，攒着的不丢


def http_post(url: str, payload: dict, headers: dict, timeout: float) -> int:
    import httpx

    return httpx.post(url, json=payload, headers=headers, timeout=timeout).status_code


class Outbox:
    def __init__(self, source, *, status=None, post=http_post, clock=time.monotonic, background: bool = True):
        self.source = source
        self.status = status
        self._post = post
        self._clock = clock
        self._background = background
        self._queue: deque[tuple[float, dict]] = deque()
        self._lock = threading.Lock()
        self._sending = threading.Lock()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._paused_until = 0.0
        self._backoff = 0.0

    def __len__(self) -> int:
        with self._lock:
            return len(self._queue)

    def put(self, entry: dict) -> None:
        with self._lock:
            self._queue.append((self._clock(), entry))
            while len(self._queue) > QUEUE_LIMIT:
                self._queue.popleft()
            full = len(self._queue) >= BATCH
        self._ensure_thread()
        if full:
            self._wake.set()

    def kick(self) -> None:
        """一轮对话结束：有攒着的就马上发，平台的「会话追踪」不用多等几秒。"""
        with self._lock:
            pending = bool(self._queue)
        if pending:
            self._wake.set()

    def _ensure_thread(self) -> None:
        if not self._background:
            return
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(target=self._run, name="uniwork-enterprise-outbox", daemon=True)
            thread = self._thread
        thread.start()

    def _run(self) -> None:
        while True:
            self._wake.wait(FLUSH_S)
            self._wake.clear()
            try:
                self.flush()
            except Exception as exc:  # noqa: BLE001 —— 后台线程不能死
                log.debug("uniwork-enterprise: tool audit flush failed: %s", type(exc).__name__)

    def _drop(self, batch: list[dict]) -> None:
        sent = {id(entry) for entry in batch}
        with self._lock:
            self._queue = deque(pair for pair in self._queue if id(pair[1]) not in sent)

    def _pause(self, seconds: float) -> None:
        self._paused_until = self._clock() + seconds

    def _send(self, settings, batch: list[dict]) -> int:
        url = settings.server + PATH
        for attempt in (0, 1):
            token = self.source.token(settings.token_env, force=attempt == 1)
            if not token:
                return NO_TOKEN
            headers = {"Authorization": f"Bearer {token}", "X-Uniwork-Version": CLIENT_VERSION}
            try:
                code = int(self._post(url, {"items": batch}, headers, TIMEOUT_S))
            except Exception:  # noqa: BLE001 —— 连不上、超时：退避重试
                return NETWORK_ERROR
            if code != 401:
                return code
        return 401

    def flush(self) -> int:
        """发到队列空、出错或该歇着为止；返回这次发出去的条数。"""
        sent = 0
        with self._sending:
            while True:
                now = self._clock()
                if now < self._paused_until:
                    return sent
                settings = self.source.settings()
                with self._lock:
                    while self._queue and now - self._queue[0][0] > MAX_AGE_S:
                        self._queue.popleft()
                    if not settings.enabled or not settings.tool_audit:
                        self._queue.clear()
                        return sent
                    batch = [entry for _, entry in list(self._queue)[:BATCH]]
                if not batch:
                    return sent
                code = self._send(settings, batch)
                if 200 <= code < 300:
                    self._drop(batch)
                    self._backoff = 0.0
                    sent += len(batch)
                    self._note(code, len(batch))
                    continue
                if code == 401:
                    self._drop(batch)
                    self._pause(UNAUTHORIZED_PAUSE_S)
                elif code == NO_TOKEN:
                    self._pause(UNAUTHORIZED_PAUSE_S)
                elif code == 403:
                    with self._lock:
                        self._queue.clear()
                    self._pause(FORBIDDEN_PAUSE_S)
                elif code == 404:
                    self._pause(MISSING_PAUSE_S)
                elif code in (400, 413, 422):
                    self._drop(batch)
                    self._note(code, 0)
                    continue
                else:
                    self._backoff = min(BACKOFF_MAX_S, max(BACKOFF_MIN_S, self._backoff * 2))
                    self._pause(self._backoff)
                self._note(code, 0)
                log.info("uniwork-enterprise: tool audit upload got %s; %d queued", code, len(self))
                return sent

    def _note(self, code: int, sent: int) -> None:
        if self.status is not None:
            self.status.note_send(code, sent, len(self))
