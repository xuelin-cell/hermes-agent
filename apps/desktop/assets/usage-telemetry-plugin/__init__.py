"""UniWork desktop analytics: observer hooks and read-only execution middleware."""

from .runtime import Runtime


def register(ctx):
    runtime = Runtime(ctx)
    ctx.register_hook("pre_llm_call", runtime.start)
    ctx.register_hook("pre_api_request", runtime.request)
    ctx.register_middleware("llm_execution", runtime.llm)
    ctx.register_hook("post_auxiliary_call", runtime.auxiliary)
    ctx.register_hook("post_tool_call", runtime.after_tool)
    ctx.register_hook("post_llm_call", lambda assistant_response=None, **kw:
                      runtime.put("answer", kw, has_answer=isinstance(assistant_response, str) and bool(assistant_response.strip())))
    ctx.register_hook("on_session_end", lambda completed=None, failed=None, interrupted=None, turn_exit_reason=None, **kw:
                      runtime.put("end", kw, completed=completed, failed=failed, interrupted=interrupted,
                                  turn_exit_reason=turn_exit_reason))
    ctx.register_hook("on_skill_lifecycle", lambda action=None, skill_name=None, provenance=None, **kw:
                      runtime.put("skill_loaded", kw, skill_name=skill_name, provenance=provenance) if action == "loaded" else None)
    ctx.register_hook("subagent_start", lambda parent_session_id=None, parent_turn_id=None, child_session_id=None, **kw:
                      runtime.put("child", kw, parent_session_id=parent_session_id, parent_turn_id=parent_turn_id,
                                  child_session_id=child_session_id))
    ctx.register_hook("subagent_stop", lambda child_session_id=None, **kw:
                      runtime.put("child_end", kw, child_session_id=child_session_id))
    ctx.register_hook("pre_approval_request", lambda surface=None, **kw: runtime.put("wait_start", kw, surface=surface))
    ctx.register_hook("post_approval_response", lambda surface=None, **kw: runtime.put("wait_end", kw, surface=surface))
    ctx.register_command("usage-report", runtime.command, description="办公统计开关与上报状态（已确认 Token 累计，含本轮输入摘要）",
                         args_hint="on | off | status | flush")
    ctx.on_unload(runtime.close)
