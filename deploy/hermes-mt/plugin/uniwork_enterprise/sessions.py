"""``X-Uniwork-Session`` 和上报里用的会话号：一个对话从头到尾不变的那个。

hermes 压缩上下文时会换一个新会话号（旧的结束、新的记上 parent），子代理也有自己的会话号。平台的「会话追踪」
按会话号归组，所以用 hermes 自己的 ``SessionDB.get_conversation_root``（它给 Nous Portal 打用量标签用的就是这个）：
压缩链和子代理都追到最早那个。平台调云端运行时，这个最早的会话号就是平台给的 session_id。

每个 profile 一个只读的 SessionDB（hermes 支持同一个 state.db 开多个），结果按会话号缓存：会话的 parent 写下以后
不会再变。会话还没落库时（刚建的对话，第一次调模型之前可能还没写）不缓存，下次再查。
"""

from __future__ import annotations

import logging
import re
import threading
from collections import OrderedDict
from pathlib import Path

log = logging.getLogger("uniwork_enterprise")

CACHE_LIMIT = 4096
# 数字员工主对话的固定标题（hermes_state ``SessionDB.CANONICAL_BOT_CHAT_TITLE``，压缩后跟到最新的会话上），
# 从它分出去的会带「 #N」。这类标题看不出对话说的是什么，产物的 sessionName 改用员工说的第一句话。
PLACEHOLDER_TITLE = re.compile(r"Bot Chat( #\d+)?")
FIRST_WORDS_CHARS = 40
FIRST_WORDS_SCAN = 20


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

    def title(self, session_id: str) -> str:
        """对话的名字（产物的 sessionName）：最早那个会话的标题，没有就用它自己的。还没起好标题，或者标题是
        「Bot Chat」这类占位的，用员工在这个对话里说的第一句话。不缓存：标题是第一轮结束后另起一次模型调用生成的，
        会后到，员工也能改。"""
        session_id = str(session_id or "")
        if not session_id:
            return ""
        placeholder = ""
        try:
            with self._lock:
                if self._db is None:
                    self._db = self._db_factory()
                db = self._db
            root = self.root(session_id)
            for candidate in dict.fromkeys((root, session_id)):
                title = str(db.get_session_title(candidate) or "")
                if title and not PLACEHOLDER_TITLE.fullmatch(title):
                    return title
                placeholder = placeholder or title
            return _first_words(db, root) or placeholder
        except Exception as exc:  # noqa: BLE001
            log.debug("uniwork-enterprise: session title lookup failed: %s", type(exc).__name__)
        return placeholder


def _first_words(db, session_id: str) -> str:
    """员工在这个对话里说的第一句话：第一行，最多 ``FIRST_WORDS_CHARS`` 个字。压缩掉的也算（第一句在最早的会话里，
    可能已经压缩过）；给模型看的脚手架（hidden）和压缩摘要不算；用 / 调技能的那句按 hermes 的写法还原成
    「/技能 — 指令」。"""
    for message in db.get_messages(session_id, include_compacted=True, limit=FIRST_WORDS_SCAN):
        if message.get("role") != "user" or message.get("display_kind") == "hidden" \
                or message.get("_compressed_summary"):
            continue
        line = next((part for part in _said(message.get("content")).splitlines() if part.strip()), "")
        line = " ".join(line.split())
        if line:
            return line if len(line) <= FIRST_WORDS_CHARS else line[:FIRST_WORDS_CHARS] + "…"
    return ""


def _said(content) -> str:
    if isinstance(content, list):  # 带图片的消息：只取文字
        content = "\n".join(str(part.get("text") or "") for part in content
                            if isinstance(part, dict) and part.get("type") == "text")
    text = str(content or "")
    try:
        from agent.skill_commands import describe_skill_invocation

        return describe_skill_invocation(text) or text
    except Exception:  # noqa: BLE001 —— 拿不到 hermes 的就按原文
        return text
