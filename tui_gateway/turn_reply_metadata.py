"""Snapshots owned by the answering turn, independent of later model/config switches."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def snapshot_turn_model(result, agent) -> dict | None:
    from hermes_cli.config import load_config_readonly
    from hermes_cli.config_providers import find_provider_entry, get_compatible_custom_providers

    result = result if isinstance(result, dict) else {}
    model = _text(result.get("model")) or _text(getattr(agent, "model", None))
    provider = _text(result.get("provider")) or _text(getattr(agent, "provider", None))
    if not model:
        return None
    snapshot = {"model": model, "provider": provider, "name": ""}
    # The caller is still inside the owning profile scope and has not restored /model --once.
    try:
        cfg = load_config_readonly()
        provider_id = provider.removeprefix("custom:")
        _, entry = find_provider_entry(cfg.get("providers"), provider_id)
        if entry is None and provider == "custom":
            base_url = (_text(result.get("base_url")) or _text(getattr(agent, "base_url", None))).rstrip("/")
            matches = [item for item in get_compatible_custom_providers(cfg)
                       if base_url and _text(item.get("base_url")).rstrip("/") == base_url
                       and _text(item.get("model")) == model]
            if len(matches) == 1:
                entry = matches[0]
                provider_id = _text(entry.get("provider_key"))
        # Plan names describe an endpoint, not its individual models (same rule as the composer).
        if entry and not provider_id.startswith("desktop-mt-maas-"):
            configured_model = _text(entry.get("model")) or _text(entry.get("default_model"))
            if configured_model == model:
                snapshot["name"] = _text(entry.get("name"))
    except Exception:
        logger.debug("Could not resolve reply model display name", exc_info=True)
    return snapshot


def persist_turn_reply_metadata(agent, messages, receipt: dict | None, metadata: dict) -> None:
    """Address only this turn's committed closing assistant row, including partial replies."""
    if not metadata or not receipt or not isinstance(messages, list) or not messages:
        return
    last = messages[-1]
    row_id = last.get("_row_id")
    if (last.get("role") != "assistant" or last.get("tool_calls")
            or row_id not in receipt["row_ids"]):
        return
    db = getattr(agent, "_session_db", None)
    if db is None:
        return
    try:
        if db.merge_message_display_metadata(agent.session_id, row_id, metadata):
            last["display_metadata"] = {**(last.get("display_metadata") or {}), **metadata}
    except Exception:
        logger.warning("Could not persist turn reply metadata", exc_info=True)
