"""多 Agent 协同（A2A，docs/企业版对接 27 号第 5 节、29 号第 2 节）：工具 ``uniwork_call_agent``。

- 只在有协同对象的 Agent 里出现（check_fn 看 plugin.json 的 profiles 表：员工实例里是各个托管 profile，
  平台的运行环境里是默认 profile）。系统提示里列出协同对象，描述取自它们的 Agent Card（不用鉴权，缓存 10 分钟）。
- 调 ``POST <协同对象的 url>``（JSON-RPC ``message/send``），带设备令牌和 ``X-Uniwork-Agent: <发起方 Agent 的 id>``，
  平台核对发起方的协同列表里有对方才放行。平台同步等 10 分钟；没跑完回 ``metadata.status: running``，这时每 15 秒查
  ``GET /api/open/v1/runs/<messageId>``（同样的两个头），从调用开始一共最多等 20 分钟。
- 请求在子线程里发，工具线程每秒看一次中断：员工点停止就马上返回（对方在平台上照常跑完）。
- 不调自己；每轮最多 5 次。这个工具不在 hermes 可以并行的名单里，一次只跑一个。平台的报错原话交给模型
  （-32000 对方正忙或绕成了环、-32003 没有协同关系……）。
- hermes 默认一次工具调用最多等 420 秒，转发器给有协同对象的 profile 写了
  ``timeouts.tools.sequential_calls.uniwork_call_agent``（seed/mtent.py 的 A2A_TOOL_TIMEOUT_S）。
- 设备令牌只发给和平台同源的地址。
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from urllib.parse import quote

from .outbox import CLIENT_VERSION

log = logging.getLogger("uniwork_enterprise")

TOOL = "uniwork_call_agent"
TOOLSET = "uniwork_enterprise"
SECTION_ID = "uniwork-collaborators"
AGENT_HEADER = "X-Uniwork-Agent"
RUNS_PATH = "/api/open/v1/runs/"
MAX_CALLS = 5
SEND_TIMEOUT_S = 630.0  # 平台同步等 600 秒（api_open.py 的 WAIT_LIMIT），多留一点
POLL_S = 15.0
POLL_TIMEOUT_S = 30.0
TOTAL_S = 20 * 60.0
TICK_S = 1.0
DONE = frozenset({"completed", "failed", "cancelled"})
MAX_OUTPUT_CHARS = 60_000
CARD_TTL_S = 600.0
CARD_FAIL_TTL_S = 60.0
CARD_TIMEOUT_S = 3.0
CARDS_BUDGET_S = 4.0
SECTION_MAX_CHARS = 3_800  # hermes 一段系统提示最多 4000 字，超了整段不要
DESCRIPTION_CHARS = 200

SCHEMA = {
    "name": TOOL,
    "description": (
        "把一项子任务交给企业里的另一个 Agent（协同 Agent），等它做完拿回结果。能调哪些见系统提示里的「协同 Agent」。"
        "对方看不到当前对话，也读不到这里的文件，message 要写清背景、要求和交付格式。可能要等几分钟，最长 20 分钟。"
        "接着上次的话题问同一个 Agent 时，带上上次返回的 context_id。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent": {"type": "string", "description": "协同 Agent 的 id 或名字"},
            "message": {"type": "string", "description": "交给它的任务：背景、要求、交付格式"},
            "context_id": {"type": "string", "description": "可选。上次调用同一个 Agent 返回的 context_id，接着那次的对话"},
        },
        "required": ["agent", "message"],
    },
}


class _Stop(Exception):
    """等待被打断（员工点了停止）或到了总时限。"""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def http_json(method: str, url: str, payload, headers: dict, timeout: float) -> tuple[int, object]:
    import httpx

    response = httpx.request(method, url, json=payload, headers=headers, timeout=httpx.Timeout(timeout, connect=15.0))
    try:
        body = response.json()
    except ValueError:
        body = None
    return response.status_code, body


def _interrupted() -> bool:
    try:
        from tools.interrupt import is_interrupted
    except Exception:  # noqa: BLE001 —— 测试环境没有 hermes
        return False
    return bool(is_interrupted())


def reachable(settings, me) -> list:
    """能调的协同 Agent：不是自己、地址在平台上（设备令牌只发给平台）。"""
    return [c for c in me.collaborators if c.id != me.agent_id and settings.is_platform(c.url)]


def find(collaborators, wanted: str):
    """按 id（可带 ``agent:``）或名字找协同 Agent；名字只在不重名时认。"""
    wanted = str(wanted or "").strip()
    if not wanted:
        return None
    ident = wanted.removeprefix("agent:").strip()
    for item in collaborators:
        if item.id == ident:
            return item
    named = [item for item in collaborators if item.name and item.name.strip().lower() == wanted.lower()]
    return named[0] if len(named) == 1 else None


def _texts(parts) -> str:
    return "\n".join(str(p.get("text") or "") for p in parts or []
                     if isinstance(p, dict) and p.get("kind", "text") == "text" and p.get("text"))


class Caller:
    """一个 profile 的 ``uniwork_call_agent``。"""

    def __init__(self, source, turns, profile: str, *, status=None, request=None, clock=time.monotonic,
                 interrupted=_interrupted, sleep=time.sleep, tick: float = TICK_S):
        self.source = source
        self.turns = turns
        self.profile = profile
        self.status = status
        self._request = request or (lambda *args: http_json(*args))
        self._clock = clock
        self._interrupted = interrupted
        self._sleep = sleep
        self._tick = tick

    def available(self) -> bool:
        try:
            settings = self.source.settings()
            me = settings.profile(self.profile)
            return settings.enabled and bool(me.agent_id) and bool(reachable(settings, me))
        except Exception:  # noqa: BLE001
            return False

    def handle(self, args, **kwargs) -> str:
        try:
            out = self.call(args if isinstance(args, dict) else {}, str(kwargs.get("session_id") or ""))
        except Exception as exc:  # noqa: BLE001 —— 工具出错交给模型，不抛给 hermes
            log.debug("uniwork-enterprise: a2a call failed: %s", type(exc).__name__)
            out = {"error": f"调用协同 Agent 出错：{type(exc).__name__}"}
        return json.dumps(out, ensure_ascii=False)

    # ---- 等待：请求在子线程里发，这里每 tick 秒看一次中断和总时限

    def _check(self, deadline: float) -> None:
        if self._interrupted():
            raise _Stop("interrupted")
        if self._clock() >= deadline:
            raise _Stop("timeout")

    def _wait(self, fn, deadline: float):
        box: dict = {}
        done = threading.Event()

        def run():
            try:
                box["value"] = fn()
            except BaseException as exc:  # noqa: BLE001
                box["error"] = exc
            finally:
                done.set()

        threading.Thread(target=run, name="uniwork-enterprise-a2a", daemon=True).start()
        while not done.wait(self._tick):
            self._check(deadline)
        if "error" in box:
            raise box["error"]
        return box["value"]

    def _pause(self, seconds: float, deadline: float) -> None:
        end = min(self._clock() + seconds, deadline)
        while True:
            self._check(deadline)
            left = end - self._clock()
            if left <= 0:
                return
            self._sleep(min(self._tick, left))

    def _send(self, method: str, url: str, payload, settings, agent_id: str, timeout: float, deadline: float):
        for attempt in (0, 1):
            token = self.source.token(settings.token_env, force=attempt == 1)
            if not token:
                return 0, None
            headers = {"Authorization": f"Bearer {token}", AGENT_HEADER: agent_id, "X-Uniwork-Version": CLIENT_VERSION}
            code, body = self._wait(lambda: self._request(method, url, payload, headers, timeout), deadline)
            if code != 401:  # 401 时平台还没开始跑，重读令牌再试一次不会重复运行
                return code, body
        return 401, body

    # ---- 一次调用

    def call(self, args: dict, session_id: str) -> dict:
        settings = self.source.settings()
        me = settings.profile(self.profile)
        if not settings.enabled or not me.agent_id or not me.collaborators:
            return {"error": "当前 Agent 没有可以调用的协同 Agent"}
        wanted = str(args.get("agent") or "")
        target = find(me.collaborators, wanted)
        if target is None:
            names = "、".join(f"{c.name or c.id}（{c.id}）" for c in reachable(settings, me)) or "（没有）"
            return {"error": f"没有「{wanted}」这个协同 Agent，可以调用的是：{names}"}
        if target.id == me.agent_id:
            return {"error": "不能调用自己"}
        message = str(args.get("message") or "").strip()
        if not message:
            return {"error": "message 不能为空：写清要它做什么"}
        if not settings.is_platform(target.url):
            return {"error": "这个协同 Agent 的地址不在企业管理平台上，没有调用"}
        if session_id and self.turns.count_call(session_id) > MAX_CALLS:
            return {"error": f"这一轮已经调用了 {MAX_CALLS} 次协同 Agent，先把已有的结果整理给用户"}
        name = target.name or target.id
        context_id = str(args.get("context_id") or "").strip()
        out = self._run(settings, me.agent_id, target.url, message, context_id, name)
        if self.status is not None:
            self.status.note_a2a(name, str(out.get("status") or ("error" if "error" in out else "")))
        return out

    def _run(self, settings, agent_id: str, url: str, message: str, context_id: str, name: str) -> dict:
        deadline = self._clock() + TOTAL_S
        sent = {"kind": "message", "role": "user", "messageId": str(uuid.uuid4()),
                "parts": [{"kind": "text", "text": message}]}
        if context_id:
            sent["contextId"] = context_id
        payload = {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": "message/send", "params": {"message": sent}}
        run_id = ""
        try:
            code, body = self._send("POST", url, payload, settings, agent_id, SEND_TIMEOUT_S, deadline)
            if code == 0:
                return {"error": "实例里还没有设备令牌，暂时调不了协同 Agent"}
            if code != 200 or not isinstance(body, dict):
                return {"error": f"企业管理平台回了 HTTP {code}，协同 Agent 没有调成"}
            if isinstance(body.get("error"), dict):
                error = body["error"]
                return {"error": str(error.get("message") or "协同 Agent 没有调成"), "code": error.get("code")}
            result = body.get("result") if isinstance(body.get("result"), dict) else {}
            run_id = str(result.get("messageId") or "")
            context_id = str(result.get("contextId") or context_id)
            metadata = result.get("metadata") if isinstance(result.get("metadata"), dict) else {}
            status = str(metadata.get("status") or "completed")
            output, error = _texts(result.get("parts")), ""
            if status == "failed":
                output, error = "", output
            while status not in DONE and run_id:
                self._pause(POLL_S, deadline)
                code, body = self._send("GET", settings.server + RUNS_PATH + quote(run_id, safe=""), None, settings,
                                        agent_id, POLL_TIMEOUT_S, deadline)
                if code == 404:
                    return {"error": "企业管理平台查不到这次协同运行", "agent": name, "context_id": context_id}
                if code == 200 and isinstance(body, dict):
                    status = str(body.get("status") or status)
                    output, error = str(body.get("output") or ""), str(body.get("error") or "")
        except _Stop as stop:
            if stop.reason == "interrupted":
                return {"status": "interrupted", "agent": name, "context_id": context_id,
                        "message": "已停止等待。对方 Agent 可能还在企业管理平台上继续运行。"}
            return {"status": "running", "agent": name, "context_id": context_id, "run_id": run_id,
                    "message": "等了 20 分钟对方还没做完。告诉用户它还在处理，稍后可以带上 context_id 再问它要结果。"}
        except Exception as exc:  # noqa: BLE001 —— 连不上、超时
            return {"error": f"连不上企业管理平台（{type(exc).__name__}），协同 Agent 没有调成", "agent": name}
        out = {"status": status, "agent": name, "context_id": context_id}
        if status == "completed":
            out["output"] = output[:MAX_OUTPUT_CHARS]
        else:
            out["error"] = (error or output or "协同 Agent 没有完成")[:2000]
        return out


# ---------------------------------------------------------------- 系统提示里的协同 Agent


class Cards:
    """协同 Agent 的 Agent Card（描述和对外能力），按地址缓存。"""

    def __init__(self, request=None, clock=time.monotonic):
        self._request = request or (lambda *args: http_json(*args))
        self._clock = clock
        self._cache: dict[str, tuple[float, dict | None]] = {}
        self._lock = threading.Lock()

    def get(self, url: str, settings, deadline: float) -> dict | None:
        now = self._clock()
        with self._lock:
            hit = self._cache.get(url)
        if hit is not None and hit[0] > now:
            return hit[1]
        if not url or not settings.is_platform(url) or now >= deadline:
            return hit[1] if hit else None
        try:
            code, body = self._request("GET", url, None, {"X-Uniwork-Version": CLIENT_VERSION},
                                       max(0.5, min(CARD_TIMEOUT_S, deadline - now)))
        except Exception:  # noqa: BLE001
            code, body = 0, None
        card = body if code == 200 and isinstance(body, dict) else None
        with self._lock:
            self._cache[url] = (self._clock() + (CARD_TTL_S if card else CARD_FAIL_TTL_S), card)
        return card


def describe(card: dict | None) -> str:
    if not card:
        return ""
    text = str(card.get("description") or "").strip()
    skills = [str(s.get("name") or "").strip() for s in card.get("skills") or [] if isinstance(s, dict)]
    skills = [s for s in skills if s]
    if skills:
        text = (text + "；" if text else "") + "能力：" + "、".join(skills)
    text = " ".join(text.split())
    return text[:DESCRIPTION_CHARS] + ("…" if len(text) > DESCRIPTION_CHARS else "")


def section_text(settings, me, cards: Cards, clock=time.monotonic) -> str:
    """新会话的系统提示里加的一段；没有能调的协同对象就是空的（hermes 不加这一段）。"""
    peers = reachable(settings, me) if settings.enabled and me.agent_id else []
    if not peers:
        return ""
    head = (f"你可以用工具 {TOOL} 把子任务交给下面这些企业 Agent（协同 Agent）。它们各有自己的知识、技能和工具，"
            "看不到你和用户的对话，也读不到你这里的文件：")
    tail = ("只在用得上它们的专长时调用；message 里写清背景、要求和交付格式；一次交给一个 Agent 一件事，"
            f"每轮最多调 {MAX_CALLS} 次，每次可能要等几分钟。它们的回复是参考材料，核对后再交给用户。")
    deadline = clock() + CARDS_BUDGET_S
    rows = [(f"- {c.name or c.id}（agent: {c.id}）", describe(cards.get(c.card_url, settings, deadline)))
            for c in peers]
    lines = [f"{label}：{desc}" if desc else label for label, desc in rows]
    if len("\n".join([head, *lines, tail])) > SECTION_MAX_CHARS:
        lines = [label for label, _ in rows]
    while lines and len("\n".join([head, *lines, tail])) > SECTION_MAX_CHARS:
        lines.pop()
    return "\n".join([head, *lines, tail])


def register(ctx, source, turns, profile: str, status=None) -> None:
    caller = Caller(source, turns, profile, status=status)
    cards = Cards()
    ctx.register_tool(name=TOOL, toolset=TOOLSET, schema=SCHEMA, handler=caller.handle, check_fn=caller.available,
                      description="调用企业里的协同 Agent（A2A）", emoji="🤝")

    def collaborators_section(_info) -> str:
        settings = source.settings()
        return section_text(settings, settings.profile(profile), cards)

    ctx.register_system_prompt_section(SECTION_ID, collaborators_section)
