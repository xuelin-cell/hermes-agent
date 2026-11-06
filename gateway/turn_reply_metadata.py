"""Attach message-platform turn metadata to a durable assistant reply."""

from tui_gateway.turn_reply_metadata import persist_turn_reply_metadata, snapshot_turn_model
from tui_gateway.turn_token_usage import turn_token_delta


def persist_gateway_reply_metadata(
    agent, history: list[dict], result: dict, usage_before: dict[str, int] | None, completed_at: float,
) -> None:
    if (not isinstance(result, dict) or not result.get("final_response") or result.get("failed")
            or result.get("interrupted") or result.get("completed") is False or result.get("error")):
        return

    metadata = {"turn_completed_at": completed_at}
    if (usage := turn_token_delta(usage_before, agent)) is not None:
        metadata["turn_token_usage"] = usage
    if (model := snapshot_turn_model(result, agent)) is not None:
        metadata["turn_model"] = model
    persist_turn_reply_metadata(agent, result.get("messages"), history, metadata)
