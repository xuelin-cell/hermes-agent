"""Register the migrated engine at Hermes' final execution boundary."""


def register(ctx):
    cleanup = []
    def inspect(execution, **kwargs):
        from .adapters.hermes import before_execute
        if not cleanup:
            from .adapters.policy import clear_all
            cleanup.append(clear_all)
        return before_execute(ctx, execution)

    ctx.register_hook("pre_tool_execute", inspect)

    def end_session(session_id="", task_id="", **kwargs):
        from hermes_constants import hermes_home_key
        from .adapters.policy import clear_session
        clear_session(hermes_home_key(), session_id or task_id)

    def unload():
        # The loader may have already evicted our module namespace.
        for clear in cleanup:
            clear()

    ctx.register_hook("on_session_end", end_session)
    ctx.on_unload(unload)
