"""Bridge desktop model picks to the owner of a live messaging route."""

import logging
from pathlib import Path

from hermes_constants import get_routing_process_hermes_home, hermes_home_key

logger = logging.getLogger(__name__)


def messaging_model_route(session_id: str, profile_home, db, *, source: str = ""):
    from tui_gateway.server import _get_db

    launch_home = get_routing_process_hermes_home()
    home = profile_home or launch_home
    if source in {"desktop", "tui", "cli", "local", "cron", "web"}:
        return None
    stores = [(home, db)]
    if hermes_home_key(home) != hermes_home_key(launch_home):
        stores.append((launch_home, _get_db()))
    for gateway_home, store in stores:
        if entry := _lookup_route(store, session_id):
            return gateway_home, entry
    # A pooled desktop backend may itself have launched under a secondary profile.
    # Its route can live only in the multiplexing gateway's launch store.
    from gateway.host_attach import host_gateway_serving, profile_name_for_home
    from hermes_state_registry import acquire, release_or_close

    profile = profile_name_for_home(home)
    if profile != "default" and (host := host_gateway_serving(profile)):
        if all(hermes_home_key(host.home) != hermes_home_key(path) for path, _ in stores):
            path = Path(host.home) / "state.db"
            if path.is_file():
                store = acquire(path)
                try:
                    if entry := _lookup_route(store, session_id):
                        return host.home, entry
                finally:
                    release_or_close(store)
    return None


def _lookup_route(db, session_id):
    lookup = getattr(db, "gateway_routing_entry_for_session", None)
    entry = lookup(session_id) if callable(lookup) else None
    if isinstance(entry, dict) and entry.get("session_key") and entry.get("origin") and not entry.get("suspended"):
        return entry
    return None


def live_messaging_model_route(session: dict):
    from tui_gateway.server import _session_db

    session_id = session.get("session_key")
    if not session_id:
        return None
    with _session_db(session) as db:
        row = db.get_session(session_id) if callable(getattr(db, "get_session", None)) else None
        return messaging_model_route(session_id, session.get("profile_home"), db,
                                     source=(row or {}).get("source") or "")


def sync_messaging_model_pick(session: dict, model: str, provider: str) -> str:
    """Return a warning if the desktop pick could not be confirmed by the message gateway."""
    from gateway.control_socket import query_gateway_control
    try:
        route = live_messaging_model_route(session)
    except Exception:
        logger.warning("Could not read the session's messaging route", exc_info=True)
        return "The model changed on desktop, but the messaging route could not be checked."
    if route is None:
        return ""
    profile_home = session.get("profile_home") or get_routing_process_hermes_home()
    gateway_home, entry = route
    result = query_gateway_control(gateway_home, "set-session-model", params={
        "session_key": entry["session_key"], "session_id": session["session_key"], "home": str(profile_home),
        "model": model, "provider": provider,
    }, timeout=6)
    if not result or result.get("applied") is not True:
        return "The model changed on desktop, but the messaging gateway did not confirm the switch."
    return ""
