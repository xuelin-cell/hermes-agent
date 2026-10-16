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
    global _ctx
    _ctx = ctx


def available() -> bool:
    return _ctx is not None and getattr(_ctx, "llm", None) is not None


def complete(prompt: str, *, max_tokens: int = 8000, timeout: float = 300.0) -> Optional[str]:
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
