"""一轮对话的现场：从 ``pre_llm_call``（一轮开始，第一次调模型之前，hermes 每轮只发一次）到 ``post_llm_call``（一轮结束）。

- 产物要「这一轮新写的」：开始时间取 pre_llm_call 那一刻（artifacts.py）；
- 平台发起的运行另外记下这一轮 write_file、patch 写出的文件（post_tool_call）；
- A2A 每轮最多调几次，按这里的计数（a2a.py）。

每个 profile 一份，按会话号存；最多记 256 个会话，旧的丢掉。一轮中间压缩了上下文，hermes 会换会话号，
后面的回调带的是新会话号、同一个 turn_id，所以按会话号找不到时再按 turn_id 找。没收到 pre_llm_call 的会话
（比如 hermes 内部分出去的后台整理）调协同 Agent 时补一个，开始时间就是那一刻。
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field

log = logging.getLogger("uniwork_enterprise")

LIMIT = 256
WRITES_LIMIT = 64


@dataclass
class Turn:
    session_id: str
    turn_id: str
    started: float  # time.time()，和文件的修改时间比
    platform: str = ""
    task_id: str = ""
    writes: list[str] = field(default_factory=list)
    calls: int = 0  # 这一轮调了几次协同 Agent


class Turns:
    def __init__(self, clock=time.time):
        self._clock = clock
        self._turns: OrderedDict[str, Turn] = OrderedDict()
        self._lock = threading.Lock()

    def begin(self, session_id: str, turn_id: str = "", *, platform: str = "", task_id: str = "") -> Turn:
        turn = Turn(str(session_id), str(turn_id or ""), self._clock(), str(platform or ""), str(task_id or ""))
        with self._lock:
            self._turns[turn.session_id] = turn
            self._turns.move_to_end(turn.session_id)
            while len(self._turns) > LIMIT:
                self._turns.popitem(last=False)
        return turn

    def _find(self, session_id: str, turn_id: str) -> tuple[str, Turn] | None:
        """调用方持锁。给了 ``turn_id`` 就必须是那一轮（旧轮迟到的回调不算进新的一轮）。"""
        turn = self._turns.get(session_id)
        if turn is not None and (not turn_id or not turn.turn_id or turn.turn_id == turn_id):
            return session_id, turn
        if turn_id:
            for key, other in reversed(self._turns.items()):
                if other.turn_id == turn_id:
                    return key, other
        return None

    def current(self, session_id: str, turn_id: str = "") -> Turn | None:
        """这个会话正在进行的那一轮。"""
        with self._lock:
            found = self._find(str(session_id), str(turn_id or ""))
        return found[1] if found else None

    def note_write(self, session_id: str, turn_id: str, path: str) -> None:
        turn = self.current(session_id, turn_id)
        if turn is None or not path:
            return
        with self._lock:
            if path not in turn.writes and len(turn.writes) < WRITES_LIMIT:
                turn.writes.append(path)

    def count_call(self, session_id: str) -> int:
        """这一轮又调了一次协同 Agent，返回算上这次是第几次。"""
        turn = self.current(session_id) or self.begin(session_id)
        with self._lock:
            turn.calls += 1
            return turn.calls

    def end(self, session_id: str, turn_id: str = "") -> Turn | None:
        """一轮结束：取走这一轮的现场。"""
        with self._lock:
            found = self._find(str(session_id), str(turn_id or ""))
            if found is None:
                return None
            del self._turns[found[0]]
            return found[1]

    def hook_begin(self, session_id="", turn_id="", platform="", task_id="", **_kwargs):
        """``pre_llm_call`` 回调：只记开始，不往对话里加东西。"""
        try:
            if session_id:
                self.begin(str(session_id), str(turn_id or ""), platform=str(platform or ""), task_id=str(task_id or ""))
        except Exception as exc:  # noqa: BLE001
            log.debug("uniwork-enterprise: turn start not recorded: %s", type(exc).__name__)
        return None
