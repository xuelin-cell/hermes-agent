"""Accept a desktop model pick for a session owned by this messaging gateway."""

import asyncio
from concurrent.futures import TimeoutError


def session_model_switch_verb(runner, loop):
    async def apply(params: dict) -> dict:
        from gateway.run import _resolve_runtime_agent_kwargs_for_provider
        from hermes_constants import get_routing_process_hermes_home, hermes_home_key

        session_key, session_id, home, model, provider = (
            params.get(key) for key in ("session_key", "session_id", "home", "model", "provider")
        )
        if not all(isinstance(value, str) and value.strip() for value in
                   (session_key, session_id, home, model, provider)):
            return {"applied": False}
        async with runner._model_switch_lock():
            store = runner.async_session_store
            entry = await store.lookup_by_session_key(session_key)
            if entry is None or entry.session_id != session_id or entry.suspended:
                return {"applied": False}
            source = runner._restored_source(entry)
            if source is None:
                return {"applied": False}
            owner = runner._profile_scope_key_for_source(source) or get_routing_process_hermes_home()
            if hermes_home_key(owner) != hermes_home_key(home):
                return {"applied": False}
            async with runner._async_profile_scope_for_source(source):
                runtime = await asyncio.to_thread(_resolve_runtime_agent_kwargs_for_provider, provider, model)
            if not await store.set_model_override(
                session_key, {"model": model, "provider": provider}, expected_session_id=session_id,
            ):
                return {"applied": False}
            # The normal route signature rebuilds the cache for the next turn without
            # mutating an agent that is still answering on the previous model.
            state = runner._session_state(session_key).conversation
            state.model_override = {**runtime, "model": model, "provider": provider}
            state.one_turn_restore = None
            if notes := getattr(runner, "_pending_model_notes", None):
                notes.pop(session_key, None)
        return {"applied": True}

    def handler(params: dict) -> dict:
        future = asyncio.run_coroutine_threadsafe(apply(params), loop)
        try:
            return future.result(timeout=5)
        except TimeoutError:
            return {"applied": False}

    return handler
