"""思考深度一律交给服务器默认：发请求前去掉各协议里的深度档位。

各家接受的档位不一样，Hermes 按自己的档位发过去会被拒：元景的 DeepSeek V4.1 不收默认的
medium，V4 不收 xhigh。桌面版不再让用户调，也不替用户选。

只去“想多深”，不动“想不想”：官方 DeepSeek 要求每次都带 ``thinking`` 开关，删了会报错；
OpenAI Responses 的 ``summary`` 只管是否返回思考摘要，也保留。旧版 Claude 的
``budget_tokens`` 与开关绑在一起、Gemini 的思考配置不在这几个字段里，这两种保持原样。
"""

import logging

logger = logging.getLogger(__name__)

# 字段名 -> 其中表示深度的子键；None 表示整个字段就是深度。
_LEVEL_FIELDS = {
    "reasoning_effort": None,  # OpenAI 兼容接口（元景、DeepSeek、GLM 等）
    "reasoning": ("effort", "max_tokens"),  # OpenRouter / Nous / OpenAI Responses
    "output_config": ("effort",),  # 新版 Claude 的自适应思考
}


def _without_levels(body):
    """返回去掉深度档位后的新字典；没有可去的就返回 None，原字典不改。"""
    if not isinstance(body, dict):
        return None
    result, changed = dict(body), False
    for name, keys in _LEVEL_FIELDS.items():
        if name not in result:
            continue
        value = result[name]
        if keys is None:
            result.pop(name)
            changed = True
        elif isinstance(value, dict) and any(key in value for key in keys):
            rest = {key: item for key, item in value.items() if key not in keys}
            if rest:
                result[name] = rest
            else:
                result.pop(name)
            changed = True
    extra = _without_levels(result.get("extra_body"))
    if extra is not None:
        if extra:
            result["extra_body"] = extra
        else:
            result.pop("extra_body")
        changed = True
    return result if changed else None


def strip_reasoning_levels(request):
    """llm_request 中间件的一步：有深度档位就返回去掉后的请求，否则返回 None。"""
    try:
        return _without_levels(request)
    except Exception:
        logger.warning("Reasoning level strip skipped", exc_info=True)
        return None
