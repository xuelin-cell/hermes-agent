"""Snapshot display metadata for the committed closing reply of a cron run."""

from agent.context_compressor import _DB_PERSISTED_MARKER
from tui_gateway.turn_reply_metadata import snapshot_turn_model
from tui_gateway.turn_token_usage import turn_token_delta


def snapshot_cron_reply_metadata(
    agent, result: dict, usage_before: dict[str, int] | None, completed_at: float,
) -> tuple[int, dict] | None:
    messages = result.get("messages")
    if not isinstance(messages, list) or not messages:
        return None
    reply = messages[-1]
    if not isinstance(reply, dict):
        return None
    row_id = reply.get("_row_id")
    if (reply.get("role") != "assistant" or reply.get("tool_calls")
            or not reply.get(_DB_PERSISTED_MARKER) or type(row_id) is not int or row_id <= 0):
        return None

    metadata = {}
    if (usage := turn_token_delta(usage_before, agent)) is not None:
        metadata["turn_token_usage"] = usage
    if (model := snapshot_turn_model(result, agent)) is not None:
        metadata["turn_model"] = model
    # Cron can deliver a resumable summary at the iteration limit before the work is complete.
    if result.get("completed") is not False and not result.get("error"):
        metadata["turn_completed_at"] = completed_at
    return (row_id, metadata) if metadata else None
