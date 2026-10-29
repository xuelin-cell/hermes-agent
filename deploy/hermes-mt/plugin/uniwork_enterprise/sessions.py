"""``X-Uniwork-Session`` 和上报里用的会话号：一个对话从头到尾不变的那个。

hermes 压缩上下文时会换一个新会话号（旧的结束、新的记上 parent），子代理也有自己的会话号。平台的「会话追踪」
按会话号归组，所以用 hermes 自己的 ``SessionDB.get_conversation_root``（它给 Nous Portal 打用量标签用的就是这个）：
压缩链和子代理都追到最早那个。平台调云端运行时，这个最早的会话号就是平台给的 session_id。

每个 profile 一个只读的 SessionDB（hermes 支持同一个 state.db 开多个），结果按会话号缓存：会话的 parent 写下以后
不会再变。会话还没落库时（刚建的对话，第一次调模型之前可能还没写）不缓存，下次再查。
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from pathlib import Path

log = logging.getLogger("uniwork_enterprise")

CACHE_LIMIT = 4096


class ConversationRoots:
    def __init__(self, home: Path, *, db_factory=None):
        self.home = Path(home)
        self._db_factory = db_factory or self._open
        self._db = None
        self._cache: OrderedDict[str, str] = OrderedDict()
        self._lock = threading.Lock()

    def _open(self):
        from hermes_state import SessionDB

        return SessionDB(db_path=self.home / "state.db", read_only=True)

    def root(self, session_id: str) -> str:
        """``session_id`` 所在对话最早的会话号；查不到就是它自己。"""
        session_id = str(session_id or "")
        if not session_id:
            return ""
        with self._lock:
            hit = self._cache.get(session_id)
            if hit is not None:
                self._cache.move_to_end(session_id)
                return hit
        try:
            with self._lock:
                if self._db is None:
                    self._db = self._db_factory()
                db = self._db
            root = str(db.get_conversation_root(session_id) or session_id)
            known = root != session_id or db.get_session(session_id) is not None
        except Exception as exc:  # noqa: BLE001 —— 查不到就用它自己，不影响对话
            log.debug("uniwork-enterprise: conversation root lookup failed: %s", type(exc).__name__)
            return session_id
        if known:
            with self._lock:
                self._cache[session_id] = root
                while len(self._cache) > CACHE_LIMIT:
                    self._cache.popitem(last=False)
        return root
