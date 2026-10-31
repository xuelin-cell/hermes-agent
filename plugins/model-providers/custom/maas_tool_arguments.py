"""MaaS DeepSeek 工具参数兼容；不改变 Hermes 核心的校验与执行流程。"""

import json
import logging
from urllib.parse import urlsplit

from openai import OpenAI, Stream
from openai.types.chat import ChatCompletion, ChatCompletionChunk
from openai.types.chat.chat_completion_chunk import (
    ChoiceDelta,
    ChoiceDeltaToolCall,
    ChoiceDeltaToolCallFunction,
)

logger = logging.getLogger(__name__)


def _is_maas_endpoint(base_url):
    """限定实测 MaaS 地址，避免影响其它自定义模型服务。"""
    parsed = urlsplit(str(base_url or ""))
    return (
        parsed.scheme == "https"
        and parsed.hostname == "maas-api.ai-yuanjing.com"
        and parsed.port in (None, 443)
        and parsed.path.rstrip("/") == "/openapi/compatible-mode/token-plan/v1"
        and not parsed.query
        and not parsed.fragment
    )


def _normalize_arguments(arguments, finish_reason):
    """只删除正常工具调用中完整 JSON 对象后恰好一份空字符串。"""
    if finish_reason != "tool_calls" or not arguments.rstrip().endswith('""'):
        return arguments
    candidate = arguments.rstrip()[:-2].rstrip()
    try:
        if not isinstance(json.loads(candidate), dict):
            return arguments
    except (ValueError, RecursionError):
        return arguments
    logger.info("MaaS DeepSeek tool arguments: removed one trailing JSON empty string")
    return candidate


def _argument_delta(index, arguments):
    """沿原工具索引补发参数，不改变工具名称、ID 或额外字段。"""
    return ChoiceDeltaToolCall(
        index=index, function=ChoiceDeltaToolCallFunction(arguments=arguments)
    )


def _normalize_stream(source):
    """思考和正文即时透传；参数等到结束原因明确后再交给原版累加器。"""
    pending = {}
    identities = {}
    templates = {}
    for chunk in source:
        for choice in chunk.choices or []:
            arguments = pending.setdefault(choice.index, {})
            deltas = []
            for tool in choice.delta.tool_calls or []:
                identity = (choice.index, tool.index)
                if (
                    tool.id
                    and identities.get(identity, tool.id) != tool.id
                    and tool.index in arguments
                ):
                    # 索引被新 ID 复用时，先原样交还上一工具，不能合并两次调用。
                    deltas.append(
                        _argument_delta(tool.index, "".join(arguments.pop(tool.index)))
                    )
                if tool.id:
                    identities[identity] = tool.id
                if (
                    tool.function
                    and isinstance(tool.function.arguments, str)
                    and tool.index is not None
                ):
                    arguments.setdefault(tool.index, []).append(tool.function.arguments)
                    templates[choice.index] = (chunk, choice)
                    tool.function.arguments = ""
                deltas.append(tool)
            if choice.finish_reason:
                deltas.extend(
                    _argument_delta(
                        index,
                        _normalize_arguments("".join(parts), choice.finish_reason),
                    )
                    for index, parts in arguments.items()
                )
                pending.pop(choice.index, None)
            choice.delta.tool_calls = deltas or None
        yield chunk
    # 缺少结束信号时只补回原参数，不把断流伪装成正常完成。
    for index, arguments in pending.items():
        if not arguments:
            continue
        chunk, choice = templates[index]
        yield chunk.model_copy(
            update={
                "usage": None,
                "choices": [
                    choice.model_copy(
                        update={
                            "finish_reason": None,
                            "logprobs": None,
                            "delta": ChoiceDelta(
                                tool_calls=[
                                    _argument_delta(tool_index, "".join(parts))
                                    for tool_index, parts in arguments.items()
                                ]
                            ),
                        }
                    )
                ],
            }
        )


class _MaaSStream(Stream[ChatCompletionChunk]):
    """复用 SDK 的响应、迭代和上下文管理，只扩展参数处理。"""

    def __stream__(self):
        """逐片处理本请求独占的 SDK 对象，无需复制正文和思考片段。"""
        yield from _normalize_stream(super().__stream__())

    def close(self):
        """提前结束或取消时释放参数缓存及 HTTP 响应。"""
        self._iterator.close()
        super().close()


class _MaaSClient(OpenAI):
    """只在指定 MaaS 模型的 Chat Completions 响应上启用兼容。"""

    def request(self, cast_to, options, *, stream=False, stream_cls=None):
        """复用 SDK 请求、超时与连接管理，仅包装已定位的模型响应。"""
        enabled = (
            _is_maas_endpoint(self.base_url)
            and options.url == "/chat/completions"
            and isinstance(options.json_data, dict)
            and (options.extra_json or {}).get("model", options.json_data.get("model"))
            == "deepseek-v4-flash"
        )
        if enabled and stream:
            stream_cls = _MaaSStream
        result = super().request(cast_to, options, stream=stream, stream_cls=stream_cls)
        if not enabled or not isinstance(result, ChatCompletion):
            return result
        for choice in result.choices:
            for tool in choice.message.tool_calls or []:
                if tool.type == "function":
                    tool.function.arguments = _normalize_arguments(
                        tool.function.arguments, choice.finish_reason
                    )
        return result


def create_maas_client(**client_kwargs):
    """通过现有提供方入口接线，复用原版连接池且不额外重试。"""
    if not _is_maas_endpoint(client_kwargs.get("base_url")):
        return None
    if "http_client" not in client_kwargs:
        from agent.process_bootstrap import build_keepalive_http_client

        client_kwargs["http_client"] = build_keepalive_http_client(
            str(client_kwargs["base_url"])
        )
    client_kwargs.setdefault("max_retries", 0)
    return _MaaSClient(**client_kwargs)
