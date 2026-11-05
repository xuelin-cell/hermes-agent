"""Attach message-platform turn metadata to a durable assistant reply."""

from agent.context_compressor import _DB_PERSISTED_MARKER
from tui_gateway.turn_reply_metadata import persist_turn_reply_metadata, snapshot_turn_model
from tui_gateway.turn_token_usage import turn_token_delta


def persist_gateway_reply_metadata(
    agent, history: list[dict], result: dict, usage_before: dict[str, int] | None, completed_at: float,
) -> None:
    if (not isinstance(result, dict) or not result.get("final_response") or result.get("failed")
            or result.get("interrupted") or result.get("completed") is False or result.get("error")):
        return

    messages = result.get("messages")
    start = getattr(agent, "_persist_user_message_idx", None)
    if not isinstance(messages, list) or type(start) is not int or not 0 <= start < len(messages) - 1:
        return
    user, reply = messages[start], messages[-1]
    if not isinstance(user, dict) or not isinstance(reply, dict):
        return
    row_id = reply.get("_row_id")
    if (user.get("role") != "user" or reply.get("role") != "assistant" or reply.get("tool_calls")
            or not reply.get(_DB_PERSISTED_MARKER) or type(row_id) is not int or row_id <= 0):
        return
    # A cached agent may return its previous history on a turn that never reached the model.
    row_ids = {row_id}
    if type(user.get("_row_id")) is int:
        row_ids.add(user["_row_id"])
    if any(message is user or message is reply or message.get("_row_id") in row_ids for message in history):
        return

    metadata = {"turn_completed_at": completed_at}
    if (usage := turn_token_delta(usage_before, agent)) is not None:
        metadata["turn_token_usage"] = usage
    if (model := snapshot_turn_model(result, agent)) is not None:
        metadata["turn_model"] = model
    persist_turn_reply_metadata(agent, messages, {"row_ids": [row_id]}, metadata)
