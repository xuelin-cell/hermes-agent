"""思考深度交给服务器默认：发请求前去掉各协议的深度档位，开关和其他字段原样保留。"""

import copy

from tests.plugins.test_desktop_deliverables_fallback import delivery  # noqa: F401
from tests.plugins.test_desktop_deliverables_image_hints import TOOL, attached, hints  # noqa: F401
from tests.plugins.test_desktop_deliverables_uploads import uploads  # noqa: F401


def test_openai_compatible_effort_is_dropped_but_thinking_toggle_stays(uploads):  # noqa: F811
    """元景等 OpenAI 兼容接口：去掉 reasoning_effort，thinking 开关保留；消息渠道一样生效，原请求不被改动。"""
    (rewrite,) = uploads.middleware["llm_request"]
    request = {
        "model": "deepseek-v4.1-flash",
        "messages": [{"role": "user", "content": "1"}],
        "reasoning_effort": "medium",
        "extra_body": {"thinking": {"type": "enabled"}},
    }
    before = copy.deepcopy(request)
    result = rewrite(request=request, platform="feishu", model="deepseek-v4.1-flash")
    assert result["request"] == {
        "model": "deepseek-v4.1-flash",
        "messages": [{"role": "user", "content": "1"}],
        "extra_body": {"thinking": {"type": "enabled"}},
    }
    assert result["reason"] == "reasoning-default"
    assert request == before


def test_level_keys_are_dropped_inside_reasoning_and_output_config(uploads):  # noqa: F811
    """Responses 的思考摘要、OpenRouter 的开关、Claude 的自适应思考都留下，只去 effort 和 max_tokens。"""
    (rewrite,) = uploads.middleware["llm_request"]
    request = {
        "reasoning": {"effort": "high", "summary": "auto"},
        "thinking": {"type": "adaptive", "display": "summarized"},
        "output_config": {"effort": "max"},
        "extra_body": {"reasoning": {"enabled": True, "effort": "medium", "max_tokens": 2048}, "reasoning_effort": "low"},
    }
    result = rewrite(request=request, platform="desktop")["request"]
    assert result == {
        "reasoning": {"summary": "auto"},
        "thinking": {"type": "adaptive", "display": "summarized"},
        "extra_body": {"reasoning": {"enabled": True}},
    }


def test_request_without_levels_is_left_alone(uploads):  # noqa: F811
    """没有深度档位、也没有看图提示的请求不改写，不留改写记录。"""
    (rewrite,) = uploads.middleware["llm_request"]
    request = {"messages": [{"role": "user", "content": "hi"}], "extra_body": {"thinking": {"type": "disabled"}}}
    assert rewrite(request=request, platform="desktop") is None


def test_image_hint_and_level_strip_both_apply(hints):  # noqa: F811
    """同一个请求既要改看图提示又要去档位时两步都生效，后一步不会盖掉前一步。"""
    image = hints.home / "a.png"
    image.write_bytes(b"png")
    request = {
        "model": "glm-5.2",
        "messages": [{"role": "user", "content": attached(image)}],
        "reasoning_effort": "medium",
    }
    result = hints.rewrite(request=request, platform="desktop", model="glm-5.2")
    assert "reasoning_effort" not in result["request"]
    assert TOOL in result["request"]["messages"][0]["content"]
    assert result["reason"].endswith("+reasoning-default")
