"""Optional desktop messaging lifecycle behavior, using the existing gateway hook."""
import asyncio
from datetime import datetime


def _renew_idle(event, gateway, session_store):
    from hermes_cli.config import load_config

    options = load_config().get("desktop", {})
    if not options.get("messaging_auto_new_session", False):
        return
    source = event.source
    if (event.text or "").lstrip().startswith("/") or not gateway._is_user_authorized_for_source(source):
        return
    key = gateway._hm_effective_session_key_for_source(source)
    if gateway._is_session_running(key):
        return
    if session_store._has_active_processes_safe(key, context="desktop idle renewal"):
        return
    entry = session_store.lookup_by_session_key(key)
    if entry is None or entry.active_turn_token or entry.suspended:
        return
    hours = options.get("messaging_idle_hours", 6)
    if isinstance(hours, bool) or not isinstance(hours, (int, float)) or not 1 <= hours <= 24:
        return
    if (datetime.now(entry.updated_at.tzinfo) - entry.updated_at).total_seconds() >= hours * 3600:
        session_store.suspend_session(key)


async def renew_idle(*, event, gateway, session_store, **kwargs):
    if session_store is not None:
        await asyncio.to_thread(_renew_idle, event, gateway, session_store)


def register(ctx):
    ctx.register_hook("pre_gateway_dispatch", renew_idle)
