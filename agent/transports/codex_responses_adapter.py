# Adapted from HexAgent: libs/hexagent_demo/backend/hexagent_api/codex/responses_adapter.py
# Source revision b0fc59264bc3f2c85e3d7866b4cad1998f2b82a4 (zhanghr136).
"""Translate between the OpenAI Responses API and chat/completions.

Codex speaks Responses and nothing else; UniClaw's models (元景 MaaS and
friends) speak OpenAI-compatible chat/completions.  This module is the pure
translation layer between the two — no I/O, no FastAPI, so it can be unit
tested and reasoned about on its own.  ``llm_proxy`` wraps it in HTTP.

Everything here was written against real captured traffic from
``codex-cli 0.147.0`` rather than from the published spec, because Codex only
uses a subset of Responses and expects a specific subset back.

Request shape Codex actually sends (captured)::

    {
      "model": "...",
      "instructions": "<21KB harness prompt>",
      "input": [
        {"type": "message", "id": "...", "role": "developer"|"user"|"assistant",
         "content": [{"type": "input_text", "text": "..."}]},
        {"type": "function_call", "id": "...", "name": "shell_command",
         "arguments": "{...}", "call_id": "call_1"},
        {"type": "function_call_output", "id": "...", "call_id": "call_1",
         "output": "Exit code: 0\\n..."}
      ],
      "tools": [
        {"type": "function", "name", "description", "strict", "parameters"},
        {"type": "namespace", "name": "multi_agent_v1", "tools": [...]},
        {"type": "web_search", "external_web_access": false}
      ],
      "tool_choice": "auto",
      "parallel_tool_calls": false,
      "reasoning": {"summary": "auto"},
      "store": false,
      "stream": true,
      "include": ["reasoning.encrypted_content"]
    }

``store`` is always false — Codex replays the full conversation every turn, so
this adapter is stateless and needs no session bookkeeping.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator

from agent.transports.codex_provider_adapter import (
    API_PROTOCOL_DEEPSEEK_CHAT,
    API_PROTOCOL_OPENAI_CHAT_REASONING,
    API_PROTOCOL_PRESERVED_THINKING,
    ChatProviderAdapter,
    ProviderState,
    endpoint_fingerprint,
    resolve_provider_adapter,
)

logger = logging.getLogger(__name__)

__all__ = [
    "ChatRequestBuild",
    "ResponsesStreamEncoder",
    "build_chat_request",
    "sse_event",
]

# Roles chat/completions providers universally accept.  Codex also emits
# "developer"; third-party gateways rarely do, so it is folded into system.
_ROLE_MAP = {
    "user": "user",
    "assistant": "assistant",
    "system": "system",
    "developer": "system",
    "tool": "tool",
}

# Content part types Codex uses inside message items.
_TEXT_PART_TYPES = frozenset({"input_text", "output_text", "text", "summary_text"})

# Separator used to flatten a namespaced tool into a single function name.
# Codex accepts `<namespace>__<tool>` and resolves it back to the namespace on
# arrival — verified against 0.147.0.
NAMESPACE_SEPARATOR = "__"

# Input item types that carry no meaning for a chat/completions backend.
# ``reasoning`` is handled separately: DeepSeek thinking models require the
# exact reasoning text to be replayed on the assistant message that announced
# a tool call, otherwise the next request is rejected with HTTP 400.
_DROPPED_INPUT_TYPES = frozenset({"web_search_call", "item_reference"})

_COMMAND_EXIT_POLICY = """UniClaw command-result policy (mandatory):
- A shell command succeeds only when its reported exit code is 0.
- Any non-zero exit code is a failed command even when stdout contains words such as PASS, SUCCESS, completed, or succeeded.
- If stdout and the exit code conflict, explicitly report the conflict and investigate or rerun the validation; never claim the command passed.
- Expected-failure tests may pass semantically, but the top-level acceptance command must still return exit code 0 before you claim acceptance passed."""
_SHELL_EXIT_CODE_RE = re.compile(r"(?m)^Exit code:\s*(-?\d+)\s*$")
_FAILED_COMMAND_MARKER = "[UNICLAW_COMMAND_RESULT: FAILED]"

#: Windows PowerShell 5.1 hands text piped into a native program
#: (``@'...'@ | python -``) through ``$OutputEncoding``, which defaults to
#: US-ASCII: every Chinese character reaches the program as ``?``, and the
#: program writes ``???`` to disk while the command reports success. Codex runs
#: every command through PowerShell on Windows, and models reach for exactly
#: this pipe when writing multi-line files — the 2026-10 customer reports of
#: generated HTML/Markdown full of ``?``. Setting the variable for the one
#: command makes the pipe UTF-8 and changes nothing else about how PowerShell
#: runs or prints.
WINDOWS_PIPE_UTF8_PREAMBLE = "$OutputEncoding = New-Object System.Text.UTF8Encoding $false; "

# Statements PowerShell only accepts at the very start of a script; a preamble
# in front of them would turn a working command into a parse error.
_PS_LEADING_ONLY_RE = re.compile(r"^\s*(?:using\s|param\s*\(|#requires)", re.IGNORECASE)


def guard_windows_pipe_encoding(
    name: str, arguments: str, *, platform: str | None = None
) -> str:
    """Make a Windows ``shell_command`` pipe non-ASCII text as UTF-8.

    Only commands that both carry non-ASCII text and contain a pipe are
    touched — the only ones the ASCII default can corrupt — so ordinary
    commands, and Codex's judgement of which of them are safe to auto-run,
    stay exactly as the model wrote them.

    Args:
        name: Tool name the model called.
        arguments: The call's JSON arguments.
        platform: Host platform Codex runs commands on; ``sys.platform``
            when omitted.

    Returns:
        The arguments, with the preamble prepended to ``command`` when needed.
    """
    if (platform or sys.platform) != "win32" or name != "shell_command":
        return arguments
    try:
        parsed = json.loads(arguments)
    except ValueError:
        return arguments
    if not isinstance(parsed, dict):
        return arguments
    command = parsed.get("command")
    if (
        not isinstance(command, str)
        or command.isascii()
        or "|" not in command
        or "$outputencoding" in command.lower()
        or _PS_LEADING_ONLY_RE.match(command)
    ):
        return arguments
    parsed["command"] = WINDOWS_PIPE_UTF8_PREAMBLE + command
    return json.dumps(parsed, ensure_ascii=False)


def unguard_windows_pipe_encoding(name: str, arguments: str) -> str:
    """Give the model back the command it wrote, without UniClaw's preamble.

    Codex replays each call's arguments on the next request. A model shown a
    line it never wrote takes it for its own mistake — a live run spent four
    turns apologising for the "prefix" and re-running the command — so the
    preamble is added on the way to Codex and removed on the way back.

    Args:
        name: Tool name of the replayed call.
        arguments: The call's JSON arguments as Codex stored them.

    Returns:
        The arguments with the preamble removed from ``command``, if present.
    """
    if name != "shell_command" or WINDOWS_PIPE_UTF8_PREAMBLE not in arguments:
        return arguments
    try:
        parsed = json.loads(arguments)
    except ValueError:
        return arguments
    if not isinstance(parsed, dict):
        return arguments
    command = parsed.get("command")
    if not isinstance(command, str) or not command.startswith(WINDOWS_PIPE_UTF8_PREAMBLE):
        return arguments
    parsed["command"] = command[len(WINDOWS_PIPE_UTF8_PREAMBLE):]
    return json.dumps(parsed, ensure_ascii=False)


#: How much of an unparseable call is kept when it is replayed. Enough for the
#: model to recognise what it wrote; a call cut off by the output limit can be
#: tens of kilobytes, all of it useless.
_INVALID_ARGUMENTS_KEPT = 2000
_INVALID_CALL_NOTE = (
    "[UNICLAW_TOOL_CALL: NOT RUN]\n"
    "The arguments of this tool call were not valid JSON, so it did not run. This usually "
    "means the call was cut off because it was too long, or a quote or backslash inside a "
    "string was not escaped. Call the tool again with valid JSON arguments; write a large "
    "file in several smaller commands instead of one."
)


def repair_tool_arguments(arguments: str) -> str:
    """Re-encode arguments whose only fault is a raw control character.

    Models regularly put literal newlines or tabs inside a JSON string when the
    string is a multi-line script. Codex rejects those arguments outright, so
    the command never runs and the model is told the call failed. Parsing
    leniently and dumping again yields the same value in valid JSON.

    Args:
        arguments: The call's arguments as the model streamed them.

    Returns:
        Valid JSON for the same value, or the input unchanged when it is
        already valid or broken in some other way.
    """
    try:
        json.loads(arguments)
        return arguments
    except ValueError:
        pass
    try:
        parsed = json.loads(arguments, strict=False)
    except ValueError:
        return arguments
    return json.dumps(parsed, ensure_ascii=False)


def replayable_tool_arguments(arguments: str) -> tuple[str, bool]:
    """Make a replayed call's arguments acceptable to the upstream gateway.

    Codex replays every earlier call, including one whose arguments it could
    not parse. The gateway parses them too and rejects the whole request with
    HTTP 400 (``Expecting ',' delimiter``), so one bad call made every later
    turn of that conversation fail. The bad text is wrapped in a JSON object
    instead, so the request goes through and the model can see what it sent.

    Args:
        arguments: The call's arguments as Codex stored them.

    Returns:
        The arguments to send, and whether the original was a usable JSON object.
    """
    if not arguments.strip():
        return "{}", True
    try:
        parsed = json.loads(arguments)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict):
        return arguments, True
    kept = arguments[:_INVALID_ARGUMENTS_KEPT]
    if len(arguments) > _INVALID_ARGUMENTS_KEPT:
        kept += f"... [{len(arguments) - _INVALID_ARGUMENTS_KEPT} more characters]"
    return json.dumps({"invalid_arguments": kept}, ensure_ascii=False), False


def _annotate_shell_output(output: str) -> str:
    """Make a non-zero shell result unambiguous to the upstream model."""
    match = _SHELL_EXIT_CODE_RE.search(output)
    if match is None or int(match.group(1)) == 0:
        return output
    exit_code = int(match.group(1))
    return (
        f"{output.rstrip()}\n\n{_FAILED_COMMAND_MARKER}\n"
        f"The shell command failed with exit code {exit_code}. Text printed by the command "
        "does not override this status. Do not report this command or its acceptance result "
        "as passed until the contradiction is investigated and a relevant validation exits 0."
    )


def sse_event(payload: dict[str, Any]) -> bytes:
    """Encode one Responses SSE frame.

    Codex reads the ``event:`` line, so it must match ``payload["type"]``.

    Args:
        payload: The event object; must carry a ``type`` key.

    Returns:
        The encoded ``event:``/``data:`` frame, terminated by a blank line.
    """
    return f"event: {payload['type']}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


@dataclass
class ChatRequestBuild:
    """A chat/completions request plus what had to be dropped to build it.

    Attributes:
        payload: The request body to POST upstream.
        dropped_tools: Names/types of tools that have no chat equivalent.
            Surfaced for logging so silently-degraded runs are diagnosable.
        namespaces: Namespace names that were flattened into the tool list.
            The encoder needs these to split a call back into
            ``(namespace, name)`` — see :class:`ResponsesStreamEncoder`.
    """

    payload: dict[str, Any]
    dropped_tools: list[str] = field(default_factory=list)
    namespaces: list[str] = field(default_factory=list)
    protocol: str = "openai-chat"


def _extract_text(content: Any) -> str:
    """Flatten a Responses ``content`` field into plain text.

    Args:
        content: Either a string or a list of typed content parts.

    Returns:
        The concatenated text of every text-bearing part.
    """
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    chunks: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") in _TEXT_PART_TYPES:
            text = part.get("text")
            if isinstance(text, str):
                chunks.append(text)
    return "".join(chunks)


def _extract_reasoning(
    item: dict[str, Any],
    *,
    protocol: str,
    model_identity: str,
    endpoint_identity: str,
    upstream_model: str,
    allow_legacy_state: bool,
) -> str:
    """Recover reasoning text from a Responses reasoning input item.

    UniClaw emits the provider's raw ``reasoning_content`` as Responses
    ``summary_text``. Codex replays that item on later tool rounds, so the
    adapter can restore the field required by DeepSeek's chat API.
    """
    state = ProviderState.decode(item.get("encrypted_content"))
    if state is not None:
        if (
            state.protocol != protocol
            or state.model_identity != model_identity
            or state.endpoint_fingerprint != endpoint_identity
            or state.upstream_model != upstream_model
        ):
            return ""
        return state.reasoning_content

    # Backward compatibility for turns produced before provider-state markers
    # existed. Runtime requests always carry a scoped model identity, so this
    # path is limited to direct legacy callers and cannot cross endpoints.
    if not allow_legacy_state:
        return ""
    summary = _extract_text(item.get("summary"))
    if summary:
        return summary
    content = _extract_text(item.get("content"))
    if content:
        return content
    text = item.get("text")
    return text if isinstance(text, str) else ""


def _convert_tools(
    tools: Iterable[Any],
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    """Convert Responses tool declarations to chat/completions ``tools``.

    Responses declares functions flat (``{"type": "function", "name": ...}``)
    while chat nests them under a ``function`` key.  Codex additionally emits
    two shapes with no chat equivalent:

    * ``namespace`` — grouped sub-tools (Codex's multi-agent suite).  Codex's
      own tool router rejects calls to these unless it registered them itself,
      so forwarding them would let the model emit calls that can never be
      answered.  They are dropped; disable the ``multi_agent`` feature flag in
      config.toml so Codex stops advertising them in the first place.
    * ``web_search`` — a provider-side builtin. Dropped; UniClaw exposes its
      own search through skills instead.

    Args:
        tools: The ``tools`` array from the Responses request.

    Returns:
        The converted tool list, and labels for everything dropped.
    """
    converted: list[dict[str, Any]] = []
    dropped: list[str] = []
    namespaces: list[str] = []

    for tool in tools:
        if not isinstance(tool, dict):
            continue
        kind = tool.get("type")

        if kind == "function":
            name = tool.get("name")
            if not isinstance(name, str) or not name:
                continue
            fn: dict[str, Any] = {
                "name": name,
                "parameters": tool.get("parameters") or {"type": "object", "properties": {}},
            }
            description = tool.get("description")
            if isinstance(description, str) and description:
                fn["description"] = description
            converted.append({"type": "function", "function": fn})
            continue

        if kind == "namespace":
            ns_name = tool.get("name")
            inner = tool.get("tools")
            if not (isinstance(ns_name, str) and ns_name and isinstance(inner, list)):
                dropped.append(f"namespace:{ns_name}")
                continue
            # chat/completions has no tool grouping, so a namespace is flattened
            # into `<namespace>NS_SEP<tool>` functions. Codex resolves that name
            # back to (namespace, tool) on the way in, which is what makes its
            # sub-agent suite reachable over a chat-only provider.
            namespaces.append(ns_name)
            ns_desc = tool.get("description")
            for sub in inner:
                if not isinstance(sub, dict):
                    continue
                sub_name = sub.get("name")
                if not isinstance(sub_name, str) or not sub_name:
                    continue
                fn: dict[str, Any] = {
                    "name": f"{ns_name}{NAMESPACE_SEPARATOR}{sub_name}",
                    "parameters": sub.get("inputSchema")
                    or sub.get("parameters")
                    or {"type": "object", "properties": {}},
                }
                sub_desc = sub.get("description")
                parts = [p for p in (ns_desc, sub_desc) if isinstance(p, str) and p]
                if parts:
                    fn["description"] = "\n\n".join(parts)
                converted.append({"type": "function", "function": fn})
            continue

        dropped.append(str(kind))

    return converted, dropped, namespaces


def _flush_tool_calls(
    messages: list[dict[str, Any]],
    pending: list[dict[str, Any]],
    adapter: ChatProviderAdapter,
    reasoning_content: str = "",
) -> bool:
    """Emit buffered function calls as one assistant message.

    Chat/completions represents a batch of tool calls as a single assistant
    message carrying ``tool_calls``; Responses represents each as its own
    input item.  Consecutive ``function_call`` items therefore have to be
    coalesced before the matching ``tool`` results are appended.

    Args:
        messages: The chat message list being built, mutated in place.
        pending: Buffered tool calls, cleared on return.
        reasoning_content: Provider reasoning that preceded these calls.

    Returns:
        Whether a buffered assistant tool-call message was emitted.
    """
    if not pending:
        return False
    message: dict[str, Any] = {
        "role": "assistant",
        "content": None,
        "tool_calls": list(pending),
    }
    adapter.attach_reasoning(message, reasoning_content, for_tool_call=True)
    messages.append(message)
    pending.clear()
    return True


def _convert_input(
    items: Iterable[Any],
    *,
    adapter: ChatProviderAdapter,
    model_identity: str,
    endpoint_identity: str,
    upstream_model: str,
    allow_legacy_state: bool,
    replay_reasoning: bool = True,
) -> list[dict[str, Any]]:
    """Convert the Responses ``input`` array into chat ``messages``.

    Args:
        items: The ``input`` array from the Responses request.

    Returns:
        Chat-shaped messages, with tool calls coalesced and tool outputs
        attached to the call that produced them.
    """
    messages: list[dict[str, Any]] = []
    pending_calls: list[dict[str, Any]] = []
    call_names: dict[str, str] = {}
    unusable_calls: set[str] = set()
    pending_reasoning = ""

    for item in items:
        if not isinstance(item, dict):
            continue
        kind = item.get("type") or "message"

        if kind in _DROPPED_INPUT_TYPES:
            continue

        if kind == "reasoning":
            if replay_reasoning and adapter.capabilities.reasoning_replay:
                pending_reasoning += _extract_reasoning(
                    item,
                    protocol=adapter.capabilities.protocol,
                    model_identity=model_identity,
                    endpoint_identity=endpoint_identity,
                    upstream_model=upstream_model,
                    allow_legacy_state=allow_legacy_state,
                )
            continue

        if kind == "function_call":
            call_id = item.get("call_id") or item.get("id")
            name = item.get("name")
            if not isinstance(call_id, str) or not isinstance(name, str):
                continue
            arguments = item.get("arguments")
            if not isinstance(arguments, str):
                arguments = json.dumps(arguments or {}, ensure_ascii=False)
            arguments = unguard_windows_pipe_encoding(name, arguments)
            arguments, usable = replayable_tool_arguments(arguments)
            if not usable:
                unusable_calls.add(call_id)
            pending_calls.append(
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": arguments},
                }
            )
            call_names[call_id] = name
            continue

        if kind == "function_call_output":
            # The assistant message announcing these calls must land first.
            if _flush_tool_calls(messages, pending_calls, adapter, pending_reasoning):
                pending_reasoning = ""
            call_id = item.get("call_id")
            if not isinstance(call_id, str):
                continue
            output = item.get("output")
            if not isinstance(output, str):
                output = json.dumps(output, ensure_ascii=False) if output is not None else ""
            if call_id in unusable_calls:
                output = f"{output.rstrip()}\n\n{_INVALID_CALL_NOTE}".lstrip()
            elif call_names.get(call_id) == "shell_command":
                output = _annotate_shell_output(output)
            messages.append({"role": "tool", "tool_call_id": call_id, "content": output})
            continue

        if kind == "message":
            if _flush_tool_calls(messages, pending_calls, adapter, pending_reasoning):
                pending_reasoning = ""
            role = _ROLE_MAP.get(str(item.get("role") or "user"), "user")
            text = _extract_text(item.get("content"))
            if not text:
                continue
            message: dict[str, Any] = {"role": role, "content": text}
            if role == "assistant":
                adapter.attach_reasoning(
                    message,
                    pending_reasoning,
                    for_tool_call=False,
                )
            messages.append(message)
            pending_reasoning = ""
            continue

        logger.debug("codex-adapter: dropping unknown input item type %r", kind)

    _flush_tool_calls(messages, pending_calls, adapter, pending_reasoning)
    return messages


def _merge_leading_system(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse the leading run of system messages into one.

    Codex sends ``instructions`` plus a ``developer`` message; several
    OpenAI-compatible gateways only honour a single leading system message and
    silently ignore later ones, which would drop Codex's skills instructions.

    Args:
        messages: Chat messages, system-first.

    Returns:
        The same conversation with the leading system run merged.
    """
    lead: list[str] = []
    idx = 0
    for msg in messages:
        if msg.get("role") != "system":
            break
        content = msg.get("content")
        if isinstance(content, str) and content:
            lead.append(content)
        idx += 1

    if idx <= 1:
        return messages
    return [{"role": "system", "content": "\n\n".join(lead)}, *messages[idx:]]


def build_chat_request(
    body: dict[str, Any],
    *,
    upstream_model: str,
    max_tokens: int | None = None,
    thinking_mode: str = "auto",
    api_protocol: str = "auto",
    provider: str = "",
    base_url: str = "",
    model_identity: str = "",
) -> ChatRequestBuild:
    """Translate a Responses request body into a chat/completions body.

    Args:
        body: The Responses request Codex sent.
        upstream_model: The provider-side model name to call. Codex's own
            ``model`` field carries a UniClaw model id, which upstream would
            not recognise.
        max_tokens: Optional output cap from the UniClaw model config.
        thinking_mode: Provider-side thinking toggle. ``auto`` leaves the
            upstream default unchanged; ``enabled``/``disabled`` are emitted
            using the OpenAI-compatible ``thinking.type`` extension used by
            DeepSeek, MiMo and compatible gateways.
        api_protocol: Explicit upstream wire dialect, or ``auto`` to infer it.
        provider: Provider label used only by auto protocol detection.
        base_url: Upstream endpoint used only by auto protocol detection.

    Returns:
        The chat request payload plus a record of dropped tools.
    """
    mode = str(thinking_mode or "auto").strip().lower()
    adapter = resolve_provider_adapter(
        api_protocol=api_protocol,
        provider=provider,
        model=upstream_model,
        base_url=base_url,
    )
    scoped_model_identity = model_identity or upstream_model
    endpoint_identity = endpoint_fingerprint(provider=provider, base_url=base_url)
    messages: list[dict[str, Any]] = []

    instructions = body.get("instructions")
    if isinstance(instructions, str) and instructions.strip():
        messages.append(
            {"role": "system", "content": f"{instructions}\n\n{_COMMAND_EXIT_POLICY}"}
        )

    raw_input = body.get("input")
    if isinstance(raw_input, str):
        messages.append({"role": "user", "content": raw_input})
    elif isinstance(raw_input, list):
        messages.extend(
            _convert_input(
                raw_input,
                adapter=adapter,
                model_identity=scoped_model_identity,
                endpoint_identity=endpoint_identity,
                upstream_model=upstream_model,
                allow_legacy_state=not bool(model_identity),
                replay_reasoning=mode != "disabled",
            )
        )

    messages = _merge_leading_system(messages)

    tools, dropped, namespaces = _convert_tools(body.get("tools") or [])

    payload: dict[str, Any] = {
        "model": upstream_model,
        "messages": messages,
        "stream": True,
        # Ask for usage on the terminal chunk so token accounting in the
        # Codex UI stays truthful instead of showing zeros.
        "stream_options": {"include_usage": True},
    }

    if tools:
        payload["tools"] = tools
        tool_choice = body.get("tool_choice")
        if isinstance(tool_choice, (str, dict)):
            payload["tool_choice"] = tool_choice
        parallel = body.get("parallel_tool_calls")
        if isinstance(parallel, bool):
            payload["parallel_tool_calls"] = parallel

    temperature = body.get("temperature")
    if isinstance(temperature, (int, float)):
        payload["temperature"] = temperature

    # Only explicit reasoning-capable protocols receive provider-specific
    # controls. Unknown OpenAI-compatible endpoints may reject extra fields.
    effort: str | None = None
    reasoning = body.get("reasoning")
    if isinstance(reasoning, dict) and isinstance(reasoning.get("effort"), str):
        effort = reasoning["effort"]
    adapter.apply_reasoning_controls(payload, mode=mode, reasoning_effort=effort)

    if max_tokens and max_tokens > 0:
        payload["max_tokens"] = max_tokens

    if dropped:
        logger.debug("codex-adapter: dropped unsupported tools: %s", ", ".join(dropped))

    return ChatRequestBuild(
        payload=payload,
        dropped_tools=dropped,
        namespaces=namespaces,
        protocol=adapter.capabilities.protocol,
    )


@dataclass
class _ToolCallAccumulator:
    """Streaming state for one tool call being assembled from deltas."""

    index: int
    call_id: str = ""
    name: str = ""
    arguments: str = ""
    item_id: str = ""
    opened: bool = False
    namespace: str | None = None


class ResponsesStreamEncoder:
    """Turn a chat/completions SSE stream into a Responses SSE stream.

    Codex consumes a specific event vocabulary.  The sequence emitted here was
    verified against ``codex-cli 0.147.0``: it renders assistant text, executes
    tool calls, and reports token usage from exactly these events.

    Text and tool calls each open an output item, stream their deltas, then
    close; ``response.completed`` carries the assembled output list so Codex
    can persist the turn.

    Usage::

        enc = ResponsesStreamEncoder(response_id="resp_1", model="m")
        yield from enc.start()
        for chunk in upstream_chunks:
            yield from enc.feed(chunk)
        yield from enc.finish()
    """

    def __init__(
        self,
        *,
        response_id: str,
        model: str,
        namespaces: Iterable[str] = (),
        provider_protocol: str = "openai-chat",
        model_identity: str = "",
        endpoint_identity: str = "",
    ) -> None:
        """Initialise the encoder.

        Args:
            response_id: Identifier reported back to Codex for this response.
            model: Model name echoed in the response envelope.
            namespaces: Namespace names that were flattened on the way out, so
                a call to ``<ns>__<tool>`` can be split back into the
                ``namespace`` + ``name`` pair Codex's router expects. Only
                these prefixes are split, so an ordinary tool whose name
                happens to contain ``__`` is left alone.
            provider_protocol: Resolved upstream wire protocol.
            model_identity: Stable UniClaw model id used to isolate opaque
                provider state across model switches.
            endpoint_identity: Non-reversible provider endpoint fingerprint.
        """
        self._response_id = response_id
        self._model = model
        self._namespaces = tuple(namespaces)
        self._provider_protocol = provider_protocol
        self._model_identity = model_identity or model
        self._endpoint_identity = endpoint_identity
        self._output_index = 0

        self._text_open = False
        self._text_item_id = f"msg_{response_id}"
        self._text_index = 0
        self._text_parts: list[str] = []

        self._reasoning_open = False
        self._reasoning_closed = False
        self._reasoning_item_id = f"rs_{response_id}"
        self._reasoning_index = 0
        self._reasoning_parts: list[str] = []

        self._tool_calls: dict[int, _ToolCallAccumulator] = {}
        self._output: list[dict[str, Any]] = []
        self._usage: dict[str, Any] | None = None
        self._finished = False
        self.finish_reason: str | None = None

    def _envelope(self, status: str) -> dict[str, Any]:
        """Build the ``response`` object shared by envelope events."""
        env: dict[str, Any] = {
            "id": self._response_id,
            "object": "response",
            "created_at": 0,
            "status": status,
            "model": self._model,
            "output": list(self._output),
        }
        if self._usage is not None:
            env["usage"] = self._usage
        return env

    def start(self) -> Iterator[bytes]:
        """Emit the opening ``response.created`` event."""
        yield sse_event({"type": "response.created", "response": self._envelope("in_progress")})

    # -- reasoning -------------------------------------------------------

    def _open_reasoning(self) -> Iterator[bytes]:
        if self._reasoning_open or self._reasoning_closed:
            return
        self._reasoning_open = True
        self._reasoning_index = self._output_index
        self._output_index += 1
        yield sse_event(
            {
                "type": "response.output_item.added",
                "output_index": self._reasoning_index,
                "item": {
                    "id": self._reasoning_item_id,
                    "type": "reasoning",
                    "summary": [],
                    "content": [],
                },
            }
        )

    def _close_reasoning(self) -> Iterator[bytes]:
        if not self._reasoning_open:
            return
        text = "".join(self._reasoning_parts)
        item = {
            "id": self._reasoning_item_id,
            "type": "reasoning",
            "summary": ([{"type": "summary_text", "text": text}] if text else []),
            "content": [],
        }
        if text and self._provider_protocol in {
            API_PROTOCOL_DEEPSEEK_CHAT,
            API_PROTOCOL_OPENAI_CHAT_REASONING,
            API_PROTOCOL_PRESERVED_THINKING,
        }:
            item["encrypted_content"] = ProviderState(
                protocol=self._provider_protocol,
                model_identity=self._model_identity,
                reasoning_content=text,
                endpoint_fingerprint=self._endpoint_identity,
                upstream_model=self._model,
            ).encode()
        self._output.append(item)
        yield sse_event(
            {
                "type": "response.output_item.done",
                "output_index": self._reasoning_index,
                "item": item,
            }
        )
        self._reasoning_open = False
        self._reasoning_closed = True

    def _refresh_closed_reasoning(self) -> None:
        """Update final-envelope state when a provider sends late reasoning.

        Some compatible streams interleave a final reasoning delta after text
        has started. Reopening the already-completed Responses item would emit
        duplicate ids and corrupt Codex's output list. The UI keeps the safe
        prefix already streamed, while ``response.completed`` carries the full
        provider state for the next tool round.
        """
        text = "".join(self._reasoning_parts)
        for item in self._output:
            if item.get("id") != self._reasoning_item_id:
                continue
            item["summary"] = ([{"type": "summary_text", "text": text}] if text else [])
            if text and self._provider_protocol in {
                API_PROTOCOL_DEEPSEEK_CHAT,
                API_PROTOCOL_OPENAI_CHAT_REASONING,
                API_PROTOCOL_PRESERVED_THINKING,
            }:
                item["encrypted_content"] = ProviderState(
                    protocol=self._provider_protocol,
                    model_identity=self._model_identity,
                    reasoning_content=text,
                    endpoint_fingerprint=self._endpoint_identity,
                    upstream_model=self._model,
                ).encode()
            return

    # -- assistant text --------------------------------------------------

    def _open_text(self) -> Iterator[bytes]:
        if self._text_open:
            return
        self._text_open = True
        self._text_index = self._output_index
        self._output_index += 1
        yield sse_event(
            {
                "type": "response.output_item.added",
                "output_index": self._text_index,
                "item": {
                    "id": self._text_item_id,
                    "type": "message",
                    "role": "assistant",
                    "status": "in_progress",
                    "content": [],
                },
            }
        )

    def _close_text(self) -> Iterator[bytes]:
        if not self._text_open:
            return
        text = "".join(self._text_parts)
        item = {
            "id": self._text_item_id,
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": text, "annotations": []}],
        }
        self._output.append(item)
        yield sse_event(
            {
                "type": "response.output_item.done",
                "output_index": self._text_index,
                "item": item,
            }
        )
        self._text_open = False

    # -- tool calls ------------------------------------------------------

    @property
    def has_pending_tool_call(self) -> bool:
        """Whether a streamed tool call has been opened and not yet closed."""
        return any(acc.opened for acc in self._tool_calls.values())

    def _close_tool_calls(self) -> Iterator[bytes]:
        for acc in sorted(self._tool_calls.values(), key=lambda a: a.index):
            if not acc.opened:
                continue
            arguments = repair_tool_arguments(acc.arguments or "{}")
            if not acc.namespace:
                arguments = guard_windows_pipe_encoding(acc.name, arguments)
            item: dict[str, Any] = {
                "id": acc.item_id,
                "type": "function_call",
                "call_id": acc.call_id,
                "name": acc.name,
                "arguments": arguments,
                "status": "completed",
            }
            if acc.namespace:
                item["namespace"] = acc.namespace
            self._output.append(item)
            yield sse_event(
                {
                    "type": "response.function_call_arguments.done",
                    "item_id": acc.item_id,
                    "output_index": acc.index,
                    "arguments": item["arguments"],
                }
            )
            yield sse_event(
                {
                    "type": "response.output_item.done",
                    "output_index": acc.index,
                    "item": item,
                }
            )
        self._tool_calls.clear()

    def _split_namespace(self, name: str) -> tuple[str | None, str]:
        """Split a flattened tool name back into ``(namespace, name)``.

        Args:
            name: The function name the model emitted.

        Returns:
            The namespace (or ``None``) and the bare tool name.
        """
        for ns in self._namespaces:
            prefix = f"{ns}{NAMESPACE_SEPARATOR}"
            if name.startswith(prefix) and len(name) > len(prefix):
                return ns, name[len(prefix):]
        return None, name

    def _feed_tool_call_delta(self, raw: dict[str, Any]) -> Iterator[bytes]:
        """Fold one streamed ``tool_calls`` delta into its accumulator."""
        idx = raw.get("index")
        if not isinstance(idx, int):
            idx = 0

        acc = self._tool_calls.get(idx)
        if acc is None:
            acc = _ToolCallAccumulator(index=self._output_index)
            self._output_index += 1
            acc.item_id = f"fc_{self._response_id}_{idx}"
            self._tool_calls[idx] = acc

        call_id = raw.get("id")
        if isinstance(call_id, str) and call_id:
            acc.call_id = call_id

        fn = raw.get("function")
        if isinstance(fn, dict):
            name = fn.get("name")
            if isinstance(name, str) and name:
                acc.namespace, acc.name = self._split_namespace(name)
            args = fn.get("arguments")
            if isinstance(args, str) and args:
                acc.arguments += args

        # Open the item only once we know the function name — Codex keys its
        # tool router on it and an empty name is unroutable.
        if not acc.opened and acc.name:
            acc.opened = True
            if not acc.call_id:
                acc.call_id = acc.item_id
            opening: dict[str, Any] = {
                "id": acc.item_id,
                "type": "function_call",
                "call_id": acc.call_id,
                "name": acc.name,
                "arguments": "",
                "status": "in_progress",
            }
            if acc.namespace:
                opening["namespace"] = acc.namespace
            yield sse_event(
                {
                    "type": "response.output_item.added",
                    "output_index": acc.index,
                    "item": opening,
                }
            )

        if acc.opened and isinstance(fn, dict):
            args = fn.get("arguments")
            if isinstance(args, str) and args:
                yield sse_event(
                    {
                        "type": "response.function_call_arguments.delta",
                        "item_id": acc.item_id,
                        "output_index": acc.index,
                        "delta": args,
                    }
                )

    # -- driver ----------------------------------------------------------

    def feed(self, chunk: dict[str, Any]) -> Iterator[bytes]:
        """Consume one upstream chat/completions chunk.

        Args:
            chunk: A decoded ``chat.completion.chunk`` object.

        Yields:
            Zero or more Responses SSE frames.
        """
        usage = chunk.get("usage")
        if isinstance(usage, dict):
            self._usage = {
                "input_tokens": usage.get("prompt_tokens", 0) or 0,
                "output_tokens": usage.get("completion_tokens", 0) or 0,
                "total_tokens": usage.get("total_tokens", 0) or 0,
            }

        choices = chunk.get("choices")
        if not isinstance(choices, list) or not choices:
            return
        choice = choices[0]
        if not isinstance(choice, dict):
            return
        finish_reason = choice.get("finish_reason")
        if isinstance(finish_reason, str) and finish_reason:
            self.finish_reason = finish_reason
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            delta = {}

        # Gateways expose reasoning as either `reasoning_content` or `reasoning`.
        # Prefer the former when non-empty; never concatenate both aliases.
        reasoning = delta.get("reasoning_content")
        if not isinstance(reasoning, str) or not reasoning:
            reasoning = delta.get("reasoning")
        if isinstance(reasoning, str) and reasoning:
            self._reasoning_parts.append(reasoning)
            if self._reasoning_closed:
                self._refresh_closed_reasoning()
                reasoning = ""
            else:
                yield from self._open_reasoning()
        if isinstance(reasoning, str) and reasoning:
            yield sse_event(
                {
                    "type": "response.reasoning_summary_text.delta",
                    "item_id": self._reasoning_item_id,
                    "output_index": self._reasoning_index,
                    "summary_index": 0,
                    "delta": reasoning,
                }
            )

        content = delta.get("content")
        if isinstance(content, str) and content:
            # Reasoning always precedes the answer; close it before text opens
            # so the two items do not interleave in the output list.
            yield from self._close_reasoning()
            yield from self._open_text()
            self._text_parts.append(content)
            yield sse_event(
                {
                    "type": "response.output_text.delta",
                    "item_id": self._text_item_id,
                    "output_index": self._text_index,
                    "content_index": 0,
                    "delta": content,
                }
            )

        tool_calls = delta.get("tool_calls")
        if isinstance(tool_calls, list):
            yield from self._close_reasoning()
            for raw in tool_calls:
                if isinstance(raw, dict):
                    yield from self._feed_tool_call_delta(raw)

    def finish(self) -> Iterator[bytes]:
        """Close any open items and emit ``response.completed``."""
        if self._finished:
            return
        yield from self._close_reasoning()
        yield from self._close_text()
        yield from self._close_tool_calls()
        actionable = any(
            item.get("type") == "function_call"
            or (
                item.get("type") == "message"
                and bool(_extract_text(item.get("content")).strip())
            )
            for item in self._output
        )
        if not actionable:
            yield from self.fail(
                "Upstream stream ended without assistant text or a tool call.",
                code="stream_incomplete",
            )
            return
        self._finished = True
        yield sse_event({"type": "response.completed", "response": self._envelope("completed")})

    def fail(self, message: str, *, code: str = "upstream_error") -> Iterator[bytes]:
        """Emit a terminal failure Codex can surface to the user.

        Args:
            message: Human-readable reason.
            code: Short machine-readable code.

        Yields:
            The ``response.failed`` frame.
        """
        if self._finished:
            return
        self._finished = True
        envelope = self._envelope("failed")
        envelope["error"] = {"code": code, "message": message}
        yield sse_event({"type": "response.failed", "response": envelope})
