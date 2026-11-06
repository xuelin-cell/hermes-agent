"""随数字员工桌面分发的标题插件，不修改Hermes核心。"""
def register(ctx):
    """纯观察钩子不返回正文/提示变换；启动时恢复本Profile的有界待办。"""
    from .runtime import before, after_tool, after, api_started, resume_pending
    from hermes_constants import get_hermes_home
    ctx.register_hook("pre_llm_call", before)
    ctx.register_hook("post_tool_call", after_tool)
    ctx.register_hook("post_llm_call", after)
    ctx.register_hook("pre_api_request", api_started)
    resume_pending(get_hermes_home())
