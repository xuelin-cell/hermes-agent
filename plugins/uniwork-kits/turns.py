"""What the hooks remember about each session's current request.

数字员工 counted deck bounces, search budget and generated pictures per
request (one user message). Hermes hands every hook a ``session_id`` and a
``turn_id``; a new ``turn_id`` is a new request. ``pre_llm_call`` opens one
with the platform and whether the conversation is a deck. A subagent's session
never sees the user's message, so it inherits the deck flag from its parent
when ``pre_llm_call`` names one, and otherwise learns it from its own deck
work. Memory only, bounded: a restart costs at most one extra bounce or search.
"""

from __future__ import annotations

import os
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

_MAX_SESSIONS = 256
_lock = threading.Lock()
_sessions: "OrderedDict[str, Turn]" = OrderedDict()


@dataclass
class Turn:
    session_id: str
    turn_id: str = ""
    started: float = 0.0
    platform: str = ""
    deck: bool = False
    # 子代理（delegate_task 派出的子任务）的会话：只按父任务交代的写自己那一份，不收整份 PPT 的写法规则。
    subagent: bool = False
    task_id: str = ""
    rules_shown: bool = False
    bounces: int = 0
    generated: List[str] = field(default_factory=list)
    reviewed: bool = False
    searches: List[Tuple[str, List[Any], str]] = field(default_factory=list)
    in_flight: int = 0
    # Session-wide, not per request: the deck bytes last measured, by path.
    measured: Dict[str, Tuple[int, int]] = field(default_factory=dict)

    def reset_request(self, turn_id: str) -> None:
        """新一轮请求开始：清掉上一轮的计数和记录，会话级的 PPT 测量结果保留。"""
        self.turn_id = turn_id
        self.started = time.time()
        self.rules_shown = False
        self.bounces = 0
        self.generated = []
        self.reviewed = False
        self.searches = []
        self.in_flight = 0


def _get(session_id: str) -> Turn:
    """取会话的状态，没有就新建；最多保留 256 个会话，最久没用的先丢。"""
    key = str(session_id or "")
    turn = _sessions.get(key)
    if turn is None:
        turn = Turn(session_id=key)
        _sessions[key] = turn
        while len(_sessions) > _MAX_SESSIONS:
            _sessions.popitem(last=False)
    else:
        _sessions.move_to_end(key)
    return turn


def begin(
    session_id: str,
    turn_id: str,
    *,
    platform: str = "",
    deck: bool = False,
    parent_session_id: str = "",
) -> Turn:
    """在 pre_llm_call 里开一轮新请求；子代理的会话沿用父会话的平台和「在做 PPT」标记。"""
    with _lock:
        turn = _get(session_id)
        turn.reset_request(str(turn_id or ""))
        parent = _sessions.get(str(parent_session_id or "")) if parent_session_id else None
        turn.platform = str(platform or (parent.platform if parent else "") or "")
        turn.deck = bool(deck or (parent is not None and parent.deck))
        turn.subagent = bool(parent_session_id)
        return turn


def current(session_id: str, turn_id: str = "", task_id: str = "") -> Turn:
    """取会话当前这一轮；turn_id 变了说明进入下一轮，重新开始计数。"""
    with _lock:
        turn = _get(session_id)
        if turn_id and turn.turn_id != turn_id:
            turn.reset_request(str(turn_id))
        if task_id:
            turn.task_id = str(task_id)
        return turn


def peek(session_id: str) -> Optional[Turn]:
    """只看会话的状态，不新建。"""
    with _lock:
        return _sessions.get(str(session_id or ""))


def clear() -> None:
    """清空全部会话状态，测试用。"""
    with _lock:
        _sessions.clear()


def session_cwd(turn: Optional[Turn]) -> str:
    """这个会话的终端在哪个目录工作：有记录用记录的，否则用进程默认目录。"""
    if turn is not None and turn.task_id:
        try:
            from tools.terminal_tool import get_session_cwd

            found = get_session_cwd(turn.task_id)
            if found:
                return found
        except Exception:
            pass
    return os.getenv("TERMINAL_CWD") or os.getcwd()
