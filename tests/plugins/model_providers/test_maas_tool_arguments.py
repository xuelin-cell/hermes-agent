"""通过正式提供方发现、OpenAI SDK 和 Hermes 组装验证 MaaS 参数兼容。"""

import json
from types import SimpleNamespace

import httpx
import pytest
from openai import APIError, OpenAI

from agent.agent_runtime_helpers import create_openai_client
from agent.chat_completion_helpers import _StreamingCall, _ToolCallAccumulator
from providers import get_provider_profile

BASE_URL = "https://maas-api.ai-yuanjing.com/openapi/compatible-mode/token-plan/v1"
MODEL = "deepseek-v4-flash"


def chunk(tool_calls=None, finish_reason=None, **delta):
    """构造保留思考与用量字段的原始 SSE 数据。"""
    if tool_calls is not None:
        delta["tool_calls"] = tool_calls
    return {
        "id": "chat-fixture",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": MODEL,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }


def tool(arguments, index=0, name=None):
    """模拟服务端按工具索引发送参数片段。"""
    result = {"index": index, "function": {"arguments": arguments}}
    if name:
        result.update(id=f"call_{index}", type="function")
        result["function"]["name"] = name
    return result


def events(arguments='{}""', finish_reason="tool_calls"):
    """复用实测的对象片段与尾部空字符串片段。"""
    result = [
        chunk(reasoning_content="inspect skills"),
        chunk([tool("", name="skills_list")]),
    ]
    result.extend(chunk([tool(part)]) for part in [arguments[:-2], arguments[-2:]])
    if finish_reason is not None:
        result.append(chunk(finish_reason=finish_reason))
    result.append({
        **chunk(),
        "choices": [],
        "usage": {
            "prompt_tokens": 400,
            "completion_tokens": 55,
            "total_tokens": 455,
        },
    })
    return result


def client_for(
    payload, *, stream=True, base_url=BASE_URL, key="account-a", requests=None
):
    """使用独立 HTTP 夹具，经过正式主请求客户端的插件入口。"""

    def respond(request):
        """返回原始协议数据，不替换 SDK 或 Hermes 的解析器。"""
        if requests is not None:
            requests.append(request)
        if stream:
            body = (
                "".join(f"data: {json.dumps(item)}\n\n" for item in payload)
                + "data: [DONE]\n\n"
            )
            return httpx.Response(
                200, text=body, headers={"content-type": "text/event-stream"}
            )
        return httpx.Response(200, json=payload)

    agent = SimpleNamespace(provider="custom", _client_log_context=lambda: "fixture")
    return create_openai_client(
        agent,
        {
            "api_key": key,
            "base_url": base_url,
            "timeout": 7,
            "http_client": httpx.Client(transport=httpx.MockTransport(respond)),
        },
        reason="chat_completion_stream_request",
        shared=False,
    )


def consume(client, model=MODEL):
    """让原版工具累加器处理 SDK 返回值，观察是否还会误报截断。"""
    accumulator = _ToolCallAccumulator()
    chunks = list(client.chat.completions.create(model=model, messages=[], stream=True))
    finish_reason = None
    for item in chunks:
        for choice in item.choices:
            for delta in choice.delta.tool_calls or []:
                accumulator.feed(delta)
            finish_reason = choice.finish_reason or finish_reason
    calls, truncated = _StreamingCall._assemble_tool_calls(
        accumulator.materialize(), finish_reason
    )
    return calls, truncated, finish_reason, chunks


@pytest.mark.parametrize(
    "arguments,expected",
    [
        ('{}""', "{}"),
        ('  {"category":"office"} \n "" \t', '  {"category":"office"}'),
        (
            '{"nested":{"text":"引号 \\" 与括号 }"},"items":[1,2]}""',
            '{"nested":{"text":"引号 \\" 与括号 }"},"items":[1,2]}',
        ),
    ],
)
def test_complete_tool_call_removes_only_the_trailing_empty_string(arguments, expected):
    """合法对象后的一份空字符串可恢复，字段、身份、思考和用量均保留。"""
    with client_for(events(arguments)) as client:
        calls, truncated, finish_reason, chunks = consume(client)
        assert not truncated
        assert finish_reason == "tool_calls"
        assert calls[0].function.arguments == expected
        assert calls[0].function.name == "skills_list"
        assert calls[0].id == "call_0"
        assert chunks[0].choices[0].delta.reasoning_content == "inspect skills"
        assert chunks[-1].usage.total_tokens == 455
        assert client.max_retries == 0
        assert client.timeout == 7


@pytest.mark.parametrize(
    "arguments",
    [
        '{}{"category":"office"}',
        '{}"extra"',
        '{}""""',
        "{} trailing",
        '{"category":"off',
        '[]""',
        'null""',
    ],
)
def test_ambiguous_or_incomplete_arguments_are_not_repaired(arguments):
    """不补全缺失参数，不丢弃其它对象、非空字符串或说明文字。"""
    with client_for(events(arguments)) as client:
        calls, _, _, _ = consume(client)
        assert calls[0].function.arguments == arguments


@pytest.mark.parametrize("finish_reason", ["length", "stop", "content_filter", None])
def test_only_tool_calls_finish_allows_normalization(finish_reason):
    """长度不足、拒绝和缺少结束信号仍保留原参数，交由核心处理。"""
    with client_for(events(finish_reason=finish_reason)) as client:
        calls, truncated, actual_finish, _ = consume(client)
        assert calls[0].function.arguments == '{}""'
        assert truncated
        assert actual_finish == finish_reason


def test_other_model_is_unchanged():
    """同一 MaaS 地址的其它模型不启用这次兼容。"""
    with client_for(events()) as client:
        calls, truncated, _, _ = consume(client, model="another-model")
        assert calls[0].function.arguments == '{}""'
        assert truncated


def test_model_override_and_raw_response_keep_sdk_behavior():
    """请求覆盖的模型不误匹配，原始响应接口仍保留 SDK 行为。"""
    with client_for(events()) as client:
        assert isinstance(client, OpenAI)
        stream = client.chat.completions.create(
            model=MODEL,
            messages=[],
            stream=True,
            extra_body={"model": "another-model"},
        )
        assert any(
            delta.function and delta.function.arguments == '""'
            for item in stream
            for choice in item.choices
            for delta in choice.delta.tool_calls or []
        )
        response = client.chat.completions.with_raw_response.create(
            model=MODEL, messages=[], stream=True
        )
        try:
            assert response.status_code == 200
        finally:
            response.http_response.close()


@pytest.mark.parametrize(
    "base_url",
    [
        "https://maas-api.ai-yuanjing.com.evil.example/openapi/compatible-mode/token-plan/v1",
        "http://maas-api.ai-yuanjing.com/openapi/compatible-mode/token-plan/v1",
        "https://maas-api.ai-yuanjing.com/another-service/v1",
        "https://api.deepseek.com/v1",
        "http://localhost:11434/v1",
    ],
)
def test_other_endpoints_keep_the_original_custom_client(base_url):
    """通过正式发现入口确认本地模型和其它提供方仍用原客户端。"""
    assert (
        get_provider_profile("custom").create_client(api_key="test", base_url=base_url)
        is None
    )


@pytest.mark.parametrize(
    "finish_reason,expected", [("tool_calls", "{}"), ("length", '{}""')]
)
def test_non_streaming_uses_the_same_narrow_rule(finish_reason, expected):
    """非流式响应也只在正常完成的工具调用中去除尾部空字符串。"""
    payload = {
        **chunk(),
        "object": "chat.completion",
        "choices": [
            {
                "index": 0,
                "finish_reason": finish_reason,
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_0",
                            "type": "function",
                            "function": {"name": "skills_list", "arguments": '{}""'},
                        }
                    ],
                },
            }
        ],
    }
    with client_for(payload, stream=False) as client:
        result = client.chat.completions.create(model=MODEL, messages=[])
        assert result.choices[0].message.tool_calls[0].function.arguments == expected
        assert result.choices[0].finish_reason == finish_reason


def test_interleaved_tools_and_request_scopes_do_not_share_state():
    """交错工具和 A→B→A 请求分别保管参数与凭据。"""
    requests = []
    for key, category in [("account-a", "A"), ("account-b", "B"), ("account-a", "A")]:
        payload = [
            chunk([
                tool("{}", name="skills_list"),
                tool('{"category":', 1, "skills_list"),
            ]),
            chunk([tool(f'"{category}"}}""', 1), tool('""')], content="checking"),
            chunk(finish_reason="tool_calls"),
        ]
        with client_for(payload, key=key, requests=requests) as client:
            calls, truncated, _, chunks = consume(client)
            assert not truncated
            assert [call.function.arguments for call in calls] == [
                "{}",
                f'{{"category":"{category}"}}',
            ]
            assert [call.id for call in calls] == ["call_0", "call_1"]
            assert (
                "".join(item.choices[0].delta.content or "" for item in chunks)
                == "checking"
            )
    assert [request.headers["authorization"] for request in requests] == [
        "Bearer account-a",
        "Bearer account-b",
        "Bearer account-a",
    ]


def test_sdk_errors_are_propagated_and_stream_can_be_closed():
    """流中错误不被吞掉，提前关闭仍释放正式 HTTP 响应。"""
    payload = [
        *events(finish_reason=None)[:-1],
        {"error": {"message": "fixture disconnect"}},
    ]
    with client_for(payload) as client:
        stream = client.chat.completions.create(model=MODEL, messages=[], stream=True)
        with pytest.raises(APIError, match="fixture disconnect"):
            list(stream)
        assert stream.response.is_closed
    with client_for(events()) as client:
        with client.chat.completions.create(
            model=MODEL, messages=[], stream=True
        ) as stream:
            assert next(stream).choices[0].delta.reasoning_content == "inspect skills"
        assert stream.response.is_closed


@pytest.mark.parametrize("fragments", [['{}""'], list('{}""'), ["{", '}"', '"']])
def test_fragment_boundaries_and_final_argument_chunk(fragments):
    """空字符串跨片段或与结束信号同包时，仍在正常结束后才修正。"""
    payload = [chunk([tool("", name="skills_list")])]
    payload.extend(chunk([tool(part)]) for part in fragments[:-1])
    payload.append(chunk([tool(fragments[-1])], finish_reason="tool_calls"))
    with client_for(payload) as client:
        calls, truncated, _, _ = consume(client)
        assert not truncated
        assert calls[0].function.arguments == "{}"


def test_reused_index_does_not_merge_different_tool_ids():
    """服务端复用索引时，前一工具参数仍归原 ID，不能拼进后一工具。"""
    second = tool('{}""', name="skills_list")
    second["id"] = "another_call"
    payload = [
        chunk([tool('{"category":"first"}', name="skills_list")]),
        chunk([second]),
        chunk(finish_reason="tool_calls"),
    ]
    with client_for(payload) as client:
        calls, truncated, _, _ = consume(client)
        assert not truncated
        assert [call.id for call in calls] == ["call_0", "another_call"]
        assert [call.function.arguments for call in calls] == [
            '{"category":"first"}',
            "{}",
        ]


def test_real_agent_executes_skills_and_continues_without_truncation_retry(monkeypatch):
    """完整跑原版对话循环和只读技能工具，异常参数后只需正常的下一轮请求。"""
    from agent import process_bootstrap
    from run_agent import AIAgent

    requests = []

    def respond(request):
        """只替换供应商网络响应，保留真实 Agent、SDK、工具和后续请求。"""
        body = json.loads(request.content)
        requests.append(body)
        assert len(requests) <= 2, "不应因同一参数格式错误反复重试"
        if len(requests) == 1:
            assert any(
                item["function"]["name"] == "skills_list" for item in body["tools"]
            )
            payload = events()
        else:
            tool_result = next(
                item for item in body["messages"] if item["role"] == "tool"
            )
            assert json.loads(tool_result["content"])["success"] is True
            payload = [chunk(content="技能查询完成"), chunk(finish_reason="stop")]
        data = (
            "".join(f"data: {json.dumps(item)}\n\n" for item in payload)
            + "data: [DONE]\n\n"
        )
        return httpx.Response(
            200, text=data, headers={"content-type": "text/event-stream"}
        )

    def build_http_client(*_args, **_kwargs):
        """每个客户端独立持有传输对象，模拟正式请求重建。"""
        return httpx.Client(transport=httpx.MockTransport(respond))

    monkeypatch.setattr(
        process_bootstrap, "build_keepalive_http_client", build_http_client
    )
    agent = AIAgent(
        api_key="fixture-key",
        base_url=BASE_URL,
        provider="custom",
        model=MODEL,
        api_mode="chat_completions",
        enabled_toolsets=["skills"],
        max_iterations=3,
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=True,
        skip_background_review=True,
        stream_delta_callback=lambda *_args, **_kwargs: None,
    )
    try:
        result = agent.run_conversation("你现在有多少个内设技能？")
        assert result["final_response"] == "技能查询完成"
        assert not result.get("failure_reason")
        assert len(requests) == 2
        tool_call = next(
            item for item in requests[1]["messages"] if item.get("tool_calls")
        )["tool_calls"][0]
        assert tool_call["function"]["arguments"] == "{}"
    finally:
        agent.close()
