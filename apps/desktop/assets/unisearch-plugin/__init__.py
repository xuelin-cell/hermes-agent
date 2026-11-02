"""UniWork providers for Hermes' existing web_search and web_extract tools."""

from functools import partial


# 沿现有扩展入口注册能力，不增加核心工具或改变模型工具名称。
def register(ctx):
    from .provider import UniSearchProvider
    from .fetch.providers import BuiltinParseProvider, UniCrawlProvider
    from .events import notice, setup, label_extract_result
    from .tool_adapter import register_tools

    for cls in (UniSearchProvider, BuiltinParseProvider, UniCrawlProvider):
        ctx.register_web_search_provider(cls(ctx.get_config))
    register_tools(ctx)
    ctx.register_hook("on_session_start", setup)
    ctx.register_hook("transform_tool_result", label_extract_result)
    ctx.register_hook("pre_tool_call", partial(notice, "start"))
    ctx.register_hook("post_tool_call", partial(notice, "complete"))
