"""Frozen v3 events. Derived from UniClaw's usage_telemetry (uniwork_release).

Only these whitelist constructors feed the outbox. No hook payload is serialized.
"""

from datetime import datetime, timezone
from itertools import islice
import json
import unicodedata
from uuid import NAMESPACE_URL, uuid5

MAX_INTEGER = 9223372036854775807
MAX_BODY_BYTES = 256 * 1024
TOKEN_FIELDS = ("inputTokens", "outputTokens", "cachedTokens")


def text(value, limit):
    return (isinstance(value, str) and 0 < len(value) <= limit
            and value == value.strip()
            and not any(unicodedata.category(c) in {"Cc", "Cs"} for c in value))


def integer(value):
    return type(value) is int and 0 <= value <= MAX_INTEGER


def user_input(value):
    if not isinstance(value, str):
        return None
    return "".join(islice((c for c in value if c in "\n\r\t"
                          or unicodedata.category(c) not in {"Cc", "Cs"}), 2000))


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def event_id(key):
    return str(uuid5(NAMESPACE_URL, "uniwork-hermes-usage:" + key))


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def resource(identifier, name=None):
    if not text(identifier, 256):
        return None
    return {"id": identifier, **({"name": name} if text(name, 128) else {})}


def capabilities(key, turn, occurred_at, subject=None, plugin=None):
    events = []
    base = {"eventId": event_id(key), "eventName": "capability.invoke", "occurredAt": occurred_at}
    if plugin:
        usage = event_id("plugin-use:" + turn + ":" + plugin["id"])
        base.update(plugin=plugin, usageId=usage)
        events.append({**base, "eventId": event_id("plugin-event:" + usage)})
    if subject:
        events.append({**base, "subject": subject})
    return events


def usage_item(value):
    if not all(text(value.get(k), 256) for k in ("modelId", "modelName", "productId")):
        return None
    item = {k: value[k] for k in ("modelId", "modelName", "productId")}
    for k, limit in (("provider", 128), ("productName", 256)):
        if text(value.get(k), limit):
            item[k] = value[k]
    for k in TOKEN_FIELDS:
        if integer(value.get(k)):
            item[k] = value[k]
    if "cachedTokens" in item and ("inputTokens" not in item or item["cachedTokens"] > item["inputTokens"]):
        item.pop("cachedTokens")
    return item


def completed(key, session, turn, occurred_at, duration, model, input_text, usages):
    if not text(session, 256) or not text(turn, 256) or not integer(duration):
        return []
    conversation = {"sessionId": session, "turnId": turn, "durationMs": duration}
    for k in ("modelId", "modelName"):
        if text(model.get(k), 256):
            conversation[k] = model[k]
    clean_input = user_input(input_text)
    if clean_input is not None:
        conversation["userInput"] = clean_input
    event = {"eventId": event_id(key), "eventName": "conversation.turn.completed",
             "occurredAt": occurred_at, "conversation": conversation}
    items = [item for value in usages if (item := usage_item(value))]
    if items:
        event["usages"] = items
    return [event]


def field(value, name):
    return value.get(name) if isinstance(value, dict) else getattr(value, name, None)


def raw_tokens(usage, api_mode=""):
    """Read the provider usage before Hermes normalizes missing/invalid values to 0."""
    if usage is None:
        return {}
    raw = field(usage, "raw_usage")
    if raw is not None:
        usage = raw
    prompt = field(usage, "prompt_tokens")
    output = field(usage, "completion_tokens")
    details = field(usage, "prompt_tokens_details")
    cached = field(details, "cached_tokens")
    if prompt is None:
        prompt = field(usage, "input_tokens")
        output = field(usage, "output_tokens")
        cached = field(field(usage, "input_tokens_details"), "cached_tokens")
        if api_mode == "anthropic_messages" or field(usage, "cache_read_input_tokens") is not None:
            cached = field(usage, "cache_read_input_tokens")
            write = field(usage, "cache_creation_input_tokens")
            parts = (prompt, cached if cached is not None else 0, write if write is not None else 0)
            prompt = sum(parts) if all(integer(v) for v in parts) else None
    if cached is None:
        cached = field(usage, "prompt_cache_hit_tokens")
    # Legacy contract: absent cache information is 0; malformed information is unknown.
    values = {"inputTokens": prompt, "outputTokens": output,
              "cachedTokens": 0 if cached is None else cached}
    return {k: v for k, v in values.items() if integer(v)}


def normalized_tokens(usage):
    if not isinstance(usage, dict):
        return {}
    values = {"inputTokens": usage.get("prompt_tokens"), "outputTokens": usage.get("output_tokens"),
              "cachedTokens": usage.get("cache_read_tokens")}
    return {k: v for k, v in values.items() if integer(v)}
