"""多 Agent 协同（plugin/uniwork_enterprise/a2a.py）：工具 uniwork_call_agent 怎么调平台、等多久、什么时候不调，
以及系统提示里的协同 Agent。工具登记进 hermes 的 registry、check_fn、系统提示段的分发在 test_plugin.py。
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

import pytest

from .support import SERVER, TOKEN_ENV, write_settings, write_token  # 先把插件目录加进 sys.path
from uniwork_enterprise import a2a  # noqa: E402
from uniwork_enterprise.a2a import MAX_CALLS, POLL_S, RUNS_PATH, SECTION_MAX_CHARS, TOOL, TOTAL_S, Caller, Cards
from uniwork_enterprise.outbox import CLIENT_VERSION
from uniwork_enterprise.settings import Collaborator, Profile, Source
from uniwork_enterprise.turns import Turns

B_URL = SERVER + "/a2a/agents/pub_b"
B_CARD = B_URL + "/.well-known/agent-card.json"
PROFILES = {"uw-agent_a": {"agentId": "agent_a", "collaborators": [
    {"id": "agent_b", "name": "数据助手", "url": B_URL, "cardUrl": B_CARD},
    {"id": "agent_c", "name": "外面的", "url": "http://elsewhere.test/a2a/agents/pub_c"},
    {"id": "agent_a", "name": "我自己", "url": SERVER + "/a2a/agents/pub_a"},
]}, "uw-lonely": {"agentId": "agent_l", "collaborators": []}}


@pytest.fixture
def peers(root: Path) -> Path:
    write_settings(root, profiles=PROFILES)
    return root


class _Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class _Platform:
    """假平台：按顺序回 (状态码, JSON)；回复也可以是异常或函数。用完了回 ``default``。"""

    def __init__(self, replies=(), default=None):
        self.replies = list(replies)
        self.default = default
        self.calls: list[dict] = []

    def __call__(self, method, url, payload, headers, timeout):
        self.calls.append({"method": method, "url": url, "payload": payload, "headers": dict(headers),
                           "timeout": timeout})
        reply = self.replies.pop(0) if self.replies else self.default
        if isinstance(reply, Exception):
            raise reply
        return reply() if callable(reply) else reply


def _result(text="结果", status="completed", run="run-1", context="ctx-1"):
    return 200, {"jsonrpc": "2.0", "id": "x", "result": {
        "kind": "message", "role": "agent", "messageId": run, "contextId": context,
        "parts": [{"kind": "text", "text": text}], "metadata": {"status": status}}}


def _caller(root: Path, platform, *, clock=None, interrupted=lambda: False, turns=None, profile="uw-agent_a"):
    clock = clock or _Clock()
    return Caller(Source(root), turns or Turns(), profile, request=platform, clock=clock, interrupted=interrupted,
                  sleep=clock.advance, tick=0.05)


def _call(caller: Caller, session: str = "s1", **args) -> dict:
    return json.loads(caller.handle({"agent": "数据助手", "message": "查上月销售额", **args}, session_id=session))


# ---------------------------------------------------------------- 调用

def test_a_call_is_message_send_for_the_calling_agent(peers: Path) -> None:
    platform = _Platform([_result("销售额 42 万", context="ctx-9")])
    out = _call(_caller(peers, platform), context_id="ctx-8")
    assert out == {"status": "completed", "agent": "数据助手", "context_id": "ctx-9", "output": "销售额 42 万"}
    [call] = platform.calls
    assert call["method"] == "POST" and call["url"] == B_URL and call["timeout"] == a2a.SEND_TIMEOUT_S
    assert call["headers"] == {"Authorization": "Bearer tok-1", "X-Uniwork-Agent": "agent_a",
                               "X-Uniwork-Version": CLIENT_VERSION}
    payload = call["payload"]
    assert payload["jsonrpc"] == "2.0" and payload["method"] == "message/send"
    message = payload["params"]["message"]
    assert message["role"] == "user" and message["contextId"] == "ctx-8"
    assert message["parts"] == [{"kind": "text", "text": "查上月销售额"}]


@pytest.mark.parametrize("wanted", ["agent_b", "agent:agent_b", "数据助手"])
def test_a_collaborator_is_found_by_id_or_name(wanted: str) -> None:
    peers = (Collaborator("agent_b", "数据助手", B_URL), Collaborator("agent_d", "同名", ""),
             Collaborator("agent_e", "同名", ""))
    assert a2a.find(peers, wanted).id == "agent_b"
    assert a2a.find(peers, "同名") is None and a2a.find(peers, "") is None  # 重名时只认 id


def test_the_platforms_refusal_reaches_the_model_as_is(peers: Path) -> None:
    busy = "这个运行环境里还有一次运行没结束，请等它结束或先停止"
    platform = _Platform([(200, {"jsonrpc": "2.0", "id": "x", "error": {"code": -32000, "message": busy}})])
    assert _call(_caller(peers, platform)) == {"error": busy, "code": -32000}


def test_a_long_run_is_polled_until_it_finishes(peers: Path) -> None:
    clock = _Clock()
    platform = _Platform([_result("", status="running", run="run-7"), (200, {"status": "running"}),
                          (200, {"status": "completed", "output": "做完了", "error": ""})])
    out = _call(_caller(peers, platform, clock=clock))
    assert out == {"status": "completed", "agent": "数据助手", "context_id": "ctx-1", "output": "做完了"}
    polls = platform.calls[1:]
    assert [(c["method"], c["url"]) for c in polls] == [("GET", SERVER + RUNS_PATH + "run-7")] * 2
    assert polls[0]["headers"]["X-Uniwork-Agent"] == "agent_a" and polls[0]["payload"] is None
    assert clock.now - 100.0 == pytest.approx(2 * POLL_S)


@pytest.mark.parametrize(("replies", "error"), [
    ([_result("额度不足", status="failed")], "额度不足"),
    ([_result("", status="running"), (200, {"status": "failed", "output": "", "error": "超时"})], "超时"),
    ([_result("", status="running"), (200, {"status": "cancelled", "output": "", "error": ""})], "协同 Agent 没有完成"),
])
def test_a_run_that_did_not_finish_brings_back_why(peers: Path, replies, error: str) -> None:
    out = _call(_caller(peers, _Platform(replies)))
    assert out["error"] == error and out["status"] in ("failed", "cancelled") and "output" not in out


def test_twenty_minutes_is_the_limit(peers: Path) -> None:
    clock = _Clock()
    platform = _Platform([_result("", status="running", run="run-7")], default=(200, {"status": "running"}))
    out = _call(_caller(peers, platform, clock=clock))
    assert out["status"] == "running" and out["run_id"] == "run-7" and "20 分钟" in out["message"]
    assert clock.now - 100.0 == pytest.approx(TOTAL_S)
    assert len(platform.calls) == 1 + int(TOTAL_S // POLL_S) - 1


def test_stop_means_stop(peers: Path) -> None:
    """员工点了停止：不等平台回话就返回（对方在平台上照常跑完）。"""
    release = threading.Event()
    asked = threading.Event()

    def slow():
        asked.set()
        release.wait(10)
        return _result()

    caller = _caller(peers, _Platform([slow]), interrupted=asked.is_set)
    started = time.monotonic()
    try:
        out = _call(caller)
    finally:
        release.set()
    assert out["status"] == "interrupted" and time.monotonic() - started < 3


def test_a_401_rereads_the_token_once(peers: Path) -> None:
    platform = _Platform([(401, {"detail": "令牌无效"}), _result()])
    caller = _caller(peers, platform)
    caller.source.token(TOKEN_ENV)  # 缓存住旧令牌
    before = (peers / ".env").stat()
    write_token(peers, "tok-2")
    os.utime(peers / ".env", ns=(before.st_atime_ns, before.st_mtime_ns))
    assert _call(caller)["status"] == "completed"
    assert [c["headers"]["Authorization"] for c in platform.calls] == ["Bearer tok-1", "Bearer tok-2"]


def test_no_token_no_call(peers: Path) -> None:
    (peers / ".env").write_text("TERMINAL_ENV=local\n", encoding="utf-8")
    platform = _Platform()
    assert "设备令牌" in _call(_caller(peers, platform))["error"] and platform.calls == []


def test_a_network_failure_is_reported(peers: Path) -> None:
    out = _call(_caller(peers, _Platform([ConnectionError("refused")])))
    assert out["error"].startswith("连不上企业管理平台（ConnectionError）") and out["agent"] == "数据助手"


@pytest.mark.parametrize(("args", "error"), [
    ({"agent": "不认识的"}, "可以调用的是：数据助手（agent_b）"),  # 只列能调的
    ({"agent": "外面的"}, "地址不在企业管理平台上"),
    ({"agent": "我自己"}, "不能调用自己"),
    ({"message": "  "}, "message 不能为空"),
])
def test_what_is_never_sent(peers: Path, args: dict, error: str) -> None:
    platform = _Platform()
    assert error in _call(_caller(peers, platform), **args)["error"]
    assert platform.calls == []


def test_only_agents_with_collaborators_have_the_tool(peers: Path, root: Path) -> None:
    assert _caller(peers, _Platform()).available()
    lonely = _caller(peers, _Platform(), profile="uw-lonely")
    assert not lonely.available() and "没有可以调用的协同 Agent" in _call(lonely)["error"]
    assert not _caller(peers, _Platform(), profile="default").available()  # 员工的默认 profile
    write_settings(peers, enabled=False, profiles=PROFILES)
    st = (peers / ".cache/uniwork-enterprise/plugin.json").stat()
    os.utime(peers / ".cache/uniwork-enterprise/plugin.json", ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))
    assert not _caller(peers, _Platform()).available()


def test_five_calls_a_turn(peers: Path) -> None:
    turns = Turns()
    caller = _caller(peers, _Platform(default=_result()), turns=turns)
    turns.begin("s1", "s1:t:1")
    assert [_call(caller).get("status") for _ in range(MAX_CALLS)] == ["completed"] * MAX_CALLS
    assert f"已经调用了 {MAX_CALLS} 次" in _call(caller)["error"]
    turns.begin("s1", "s1:t:2")  # 下一轮重新算
    assert _call(caller)["status"] == "completed"


# ---------------------------------------------------------------- 系统提示

def _settings(root: Path):
    return Source(root).settings()


def test_the_prompt_lists_collaborators_with_their_cards(peers: Path) -> None:
    fetched = []

    def card(method, url, payload, headers, timeout):
        fetched.append(url)
        return 200, {"name": "数据助手", "description": "做数据分析", "skills": [{"id": "s", "name": "销售分析"}]}

    cards = Cards(request=card)
    settings = _settings(peers)
    text = a2a.section_text(settings, settings.profile("uw-agent_a"), cards)
    assert TOOL in text and f"每轮最多调 {MAX_CALLS} 次" in text
    assert "- 数据助手（agent: agent_b）：做数据分析；能力：销售分析" in text
    assert "外面的" not in text and "我自己" not in text  # 地址不在平台上的、自己：调不了，不列
    a2a.section_text(settings, settings.profile("uw-agent_a"), cards)
    assert fetched == [B_CARD]  # 卡片缓存住了


def test_a_card_that_cannot_be_read_leaves_just_the_name(peers: Path) -> None:
    cards = Cards(request=_Platform([OSError("refused")]))
    settings = _settings(peers)
    assert "- 数据助手（agent: agent_b）\n" in a2a.section_text(settings, settings.profile("uw-agent_a"), cards)


def test_no_collaborators_no_section(peers: Path) -> None:
    settings = _settings(peers)
    assert a2a.section_text(settings, settings.profile("uw-lonely"), Cards(request=_Platform())) == ""
    assert a2a.section_text(settings, settings.profile("default"), Cards(request=_Platform())) == ""


def test_the_section_fits_what_hermes_accepts(peers: Path) -> None:
    many = tuple(Collaborator(f"agent_{i}", "很长的名字" * 5, B_URL, f"{B_URL}/{i}") for i in range(80))
    cards = Cards(request=lambda *args: (200, {"description": "描述" * 300}))
    text = a2a.section_text(_settings(peers), Profile("agent_a", many), cards)
    assert len(text) <= SECTION_MAX_CHARS and text.count("- ") > 10
