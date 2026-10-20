"""The user's active model, borrowed through the plugin's ``ctx.llm``.

``register(ctx)`` stores the context; ``hermes kit install`` runs in the same
process, so trigger generation can use ``ctx.llm.complete`` without any
config (no provider / model override is requested, so the trust gate is not
involved). Returns ``None`` whenever no model is reachable.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

_ctx: Any = None


def set_context(ctx: Any) -> None:
    """插件加载时记下 Hermes 给的上下文，之后用它调用模型。"""
    global _ctx
    _ctx = ctx


def available() -> bool:
    """当前能不能调用模型（上下文里有 llm 能力）。"""
    return _ctx is not None and getattr(_ctx, "llm", None) is not None


def complete(prompt: str, *, max_tokens: int = 8000, timeout: float = 300.0) -> Optional[str]:
    """用一条用户消息调一次模型，返回文本；不可用或出错时返回 None，由调用方决定怎么退回。"""
    if not available():
        return None
    try:
        result = _ctx.llm.complete(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            timeout=timeout,
            temperature=0.3,
            purpose="uniwork-kits: Chinese trigger phrases",
        )
    except Exception as exc:  # no model configured, quota, network ...
        logger.warning("[uniwork-kits] trigger generation call failed: %s", exc)
        return None
    text = getattr(result, "text", None)
    return text if isinstance(text, str) and text.strip() else None
