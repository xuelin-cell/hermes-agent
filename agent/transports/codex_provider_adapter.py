# Adapted from HexAgent: libs/hexagent_demo/backend/hexagent_api/codex/provider_adapter.py
# Source revision b0fc59264bc3f2c85e3d7866b4cad1998f2b82a4 (zhanghr136).
"""Provider protocol capabilities for the Codex Responses bridge.

The bridge exposes one Responses endpoint to Codex but can call several
chat/completions dialects upstream.  Those dialects are not interchangeable:
DeepSeek, for example, requires ``reasoning_content`` to be replayed on the
assistant message that initiated a tool call.  Keeping that rule here avoids
leaking provider-specific fields into the generic Responses translator.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

API_PROTOCOL_AUTO = "auto"
API_PROTOCOL_OPENAI_CHAT = "openai-chat"
API_PROTOCOL_DEEPSEEK_CHAT = "deepseek-chat"
API_PROTOCOL_OPENAI_CHAT_REASONING = "openai-chat-reasoning-content"
API_PROTOCOL_PRESERVED_THINKING = "preserved-thinking"
REASONING_REPLAY_NONE = "none"
REASONING_REPLAY_TOOL_TURN = "tool-turn"
REASONING_REPLAY_FULL_HISTORY = "full-history"
API_PROTOCOLS = frozenset(
    {
        API_PROTOCOL_AUTO,
        API_PROTOCOL_OPENAI_CHAT,
        API_PROTOCOL_DEEPSEEK_CHAT,
        API_PROTOCOL_OPENAI_CHAT_REASONING,
        API_PROTOCOL_PRESERVED_THINKING,
    }
)
_PROVIDER_STATE_PREFIX = "uniclaw-provider-state:v1:"


def normalize_api_protocol(value: str | None) -> str:
    """Return a supported protocol name, falling back to auto detection."""
    protocol = str(value or API_PROTOCOL_AUTO).strip().lower()
    return protocol if protocol in API_PROTOCOLS else API_PROTOCOL_AUTO


@dataclass(frozen=True)
class ProviderCapabilities:
    """Protocol behaviour needed by the stateless Responses bridge."""

    protocol: str
    reasoning_replay_scope: str = REASONING_REPLAY_NONE
    preserve_reasoning_state: bool = False
    reasoning_message_field: str | None = None
    thinking_control: str | None = None
    reasoning_effort: bool = False

    @property
    def reasoning_replay(self) -> bool:
        return self.reasoning_replay_scope != REASONING_REPLAY_NONE


@dataclass(frozen=True)
class ProviderState:
    """Opaque provider state carried through Codex reasoning items.

    Codex already preserves Responses ``encrypted_content`` without reading
    it.  UniClaw uses a namespaced payload in that field so a later request can
    distinguish DeepSeek reasoning from another provider/model's state.
    """

    protocol: str
    model_identity: str
    reasoning_content: str
    endpoint_fingerprint: str = ""
    upstream_model: str = ""

    def encode(self) -> str:
        raw = json.dumps(
            {
                "protocol": self.protocol,
                "model_identity": self.model_identity,
                "reasoning_content": self.reasoning_content,
                "endpoint_fingerprint": self.endpoint_fingerprint,
                "upstream_model": self.upstream_model,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        token = base64.urlsafe_b64encode(raw).decode("ascii")
        return f"{_PROVIDER_STATE_PREFIX}{token}"

    @classmethod
    def decode(cls, value: Any) -> ProviderState | None:
        if not isinstance(value, str) or not value.startswith(_PROVIDER_STATE_PREFIX):
            return None
        token = value[len(_PROVIDER_STATE_PREFIX):]
        try:
            raw = base64.urlsafe_b64decode(token.encode("ascii"))
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError, binascii.Error):
            return None
        if not isinstance(payload, dict):
            return None
        protocol = payload.get("protocol")
        model_identity = payload.get("model_identity")
        reasoning_content = payload.get("reasoning_content")
        if not all(
            isinstance(item, str)
            for item in (protocol, model_identity, reasoning_content)
        ):
            return None
        return cls(
            protocol=protocol,
            model_identity=model_identity,
            reasoning_content=reasoning_content,
            endpoint_fingerprint=str(payload.get("endpoint_fingerprint") or ""),
            upstream_model=str(payload.get("upstream_model") or ""),
        )


def endpoint_fingerprint(*, provider: str, base_url: str) -> str:
    """Return a stable, non-reversible identity for one upstream endpoint."""
    raw_url = str(base_url or "").strip().rstrip("/")
    raw_provider = str(provider or "").strip().lower()
    if not raw_url and not raw_provider:
        return ""
    try:
        parsed = urlparse(raw_url)
        host = (parsed.hostname or "").lower()
        port = f":{parsed.port}" if parsed.port is not None else ""
        path = parsed.path.rstrip("/")
        normalized_url = f"{parsed.scheme.lower()}://{host}{port}{path}"
    except ValueError:
        normalized_url = raw_url.lower()
    identity = f"{raw_provider}\n{normalized_url}"
    return f"sha256:{hashlib.sha256(identity.encode('utf-8')).hexdigest()}"


class ChatProviderAdapter:
    """Base adapter for ordinary OpenAI-compatible chat endpoints."""

    capabilities = ProviderCapabilities(protocol=API_PROTOCOL_OPENAI_CHAT)

    def attach_reasoning(
        self,
        message: dict[str, Any],
        reasoning: str,
        *,
        for_tool_call: bool,
    ) -> None:
        """Attach provider state to an assistant message when supported."""

    def apply_reasoning_controls(
        self,
        payload: dict[str, Any],
        *,
        mode: str,
        reasoning_effort: str | None,
    ) -> None:
        """Add only controls explicitly supported by this protocol."""
        if self.capabilities.thinking_control == "thinking.type" and mode in {
            "enabled",
            "disabled",
        }:
            payload["thinking"] = {"type": mode}
        if (
            self.capabilities.reasoning_effort
            and mode != "disabled"
            and reasoning_effort
            and reasoning_effort != "none"
        ):
            payload["reasoning_effort"] = reasoning_effort


class DeepSeekChatAdapter(ChatProviderAdapter):
    """DeepSeek chat dialect with tool-loop reasoning replay."""

    capabilities = ProviderCapabilities(
        protocol=API_PROTOCOL_DEEPSEEK_CHAT,
        reasoning_replay_scope=REASONING_REPLAY_TOOL_TURN,
        preserve_reasoning_state=True,
        reasoning_message_field="reasoning_content",
        thinking_control="thinking.type",
        reasoning_effort=True,
    )

    def attach_reasoning(
        self,
        message: dict[str, Any],
        reasoning: str,
        *,
        for_tool_call: bool,
    ) -> None:
        if reasoning and (
            self.capabilities.reasoning_replay_scope == REASONING_REPLAY_FULL_HISTORY
            or (
                self.capabilities.reasoning_replay_scope == REASONING_REPLAY_TOOL_TURN
                and for_tool_call
            )
        ):
            message["reasoning_content"] = reasoning


class OpenAIChatReasoningAdapter(DeepSeekChatAdapter):
    """Capture reasoning_content without assuming replay semantics."""

    capabilities = ProviderCapabilities(
        protocol=API_PROTOCOL_OPENAI_CHAT_REASONING,
        reasoning_replay_scope=REASONING_REPLAY_NONE,
        preserve_reasoning_state=True,
        reasoning_message_field="reasoning_content",
        thinking_control="thinking.type",
        reasoning_effort=True,
    )


class PreservedThinkingAdapter(DeepSeekChatAdapter):
    """Replay every preserved assistant reasoning block in generation order."""

    capabilities = ProviderCapabilities(
        protocol=API_PROTOCOL_PRESERVED_THINKING,
        reasoning_replay_scope=REASONING_REPLAY_FULL_HISTORY,
        preserve_reasoning_state=True,
        reasoning_message_field="reasoning_content",
        thinking_control="thinking.type",
        reasoning_effort=True,
    )


_OPENAI_CHAT_ADAPTER = ChatProviderAdapter()
_AUTO_CHAT_ADAPTER = ChatProviderAdapter()
_DEEPSEEK_CHAT_ADAPTER = DeepSeekChatAdapter()
_OPENAI_CHAT_REASONING_ADAPTER = OpenAIChatReasoningAdapter()
_PRESERVED_THINKING_ADAPTER = PreservedThinkingAdapter()


def resolve_provider_adapter(
    *,
    api_protocol: str = API_PROTOCOL_AUTO,
    provider: str = "",
    model: str = "",
    base_url: str = "",
) -> ChatProviderAdapter:
    """Resolve an explicit protocol without guessing from model names."""
    protocol = normalize_api_protocol(api_protocol)
    if protocol == API_PROTOCOL_DEEPSEEK_CHAT:
        return _DEEPSEEK_CHAT_ADAPTER
    if protocol == API_PROTOCOL_OPENAI_CHAT:
        return _OPENAI_CHAT_ADAPTER
    if protocol == API_PROTOCOL_OPENAI_CHAT_REASONING:
        return _OPENAI_CHAT_REASONING_ADAPTER
    if protocol == API_PROTOCOL_PRESERVED_THINKING:
        return _PRESERVED_THINKING_ADAPTER
    return _AUTO_CHAT_ADAPTER


def classify_provider_error(message: str, *, status_code: int | None = None) -> str:
    """Map provider-specific failures to stable UniHarness error categories."""
    text = str(message or "").lower()
    if status_code == 429 or "rate limit" in text or "too many requests" in text:
        return "rate_limited"
    if (
        ("reasoning_content" in text or "thinking block" in text or "thoughtsignature" in text)
        and any(word in text for word in ("must", "missing", "required", "passed back"))
    ):
        return "reasoning_state_missing"
    if any(word in text for word in ("signature", "encrypted_content", "reasoning_content")) and any(
        word in text for word in ("invalid", "mismatch", "malformed")
    ):
        return "reasoning_state_invalid"
    if "thinking" in text and any(
        word in text for word in ("unsupported", "unknown", "unrecognized", "invalid parameter")
    ):
        return "thinking_parameter_unsupported"
    if any(word in text for word in ("context length", "context window", "maximum context", "too many tokens")):
        return "context_overflow"
    if ("tool" in text or "function" in text) and any(
        word in text for word in ("invalid", "mismatch", "unsupported", "malformed")
    ):
        return "tool_protocol_mismatch"
    if status_code is not None and status_code >= 500:
        return "provider_unavailable"
    return "upstream_http_error" if status_code is not None else "upstream_stream_error"


__all__ = [
    "API_PROTOCOLS",
    "API_PROTOCOL_AUTO",
    "API_PROTOCOL_DEEPSEEK_CHAT",
    "API_PROTOCOL_OPENAI_CHAT",
    "API_PROTOCOL_OPENAI_CHAT_REASONING",
    "API_PROTOCOL_PRESERVED_THINKING",
    "ChatProviderAdapter",
    "ProviderCapabilities",
    "ProviderState",
    "classify_provider_error",
    "endpoint_fingerprint",
    "normalize_api_protocol",
    "resolve_provider_adapter",
]
