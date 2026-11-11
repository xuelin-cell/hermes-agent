"""UniWork kits & experts for Hermes.

Hermes core does not know WorkBuddy / UniClaw packages. This plugin unpacks
them into what Hermes already has — skills, ``mcp_servers``, profiles and
``SOUL.md`` — and adds on top:

* ``hermes kit ...`` — inspect / install / seed / list / enable / disable /
  uninstall / triggers / config / media (see :mod:`.cli`);
* cache-safe system prompt sections carrying each expert's host rules
  (:mod:`.host_rules`), empty for every profile that is not an expert;
* shared reply rules and the ordinary assistant's introduction template
  (:mod:`.communication_rules`), without rewriting account personas;
* a ``pre_llm_call`` hook suggesting matching kit skills in ordinary
  conversations, and PPT picture rules that name the media slot
  (:mod:`.router`, :mod:`.media_slot`); the nine Eastmoney experts stay on
  their package scripts until a colleague's 东方财富 connector shows up in
  ``mcp_servers``, then the same hook switches that turn onto it
  (:mod:`.eastmoney_slot`);
* tool hooks doing what 数字员工's middlewares did: picture rules when a PPT
  kit loads, search hits landed as local files, decks checked when written
  (:mod:`.host_hooks`), plus a package's own command hooks
  (:mod:`.package_hooks`).

Enable with ``hermes plugins enable uniwork-kits``. Expert profiles created by
``hermes kit install`` enable it for themselves.
"""

from __future__ import annotations

from . import background_rules, cli, code_packages, codex, communication_rules, deck_timing, expert_sync, host_hooks, host_rules, llm, package_hooks, router, skill_paths, terminal_env, terminal_hints, tool_call_rules


def register(ctx) -> None:
    """插件入口：先让专家跟上默认档案、备好小红书程序，再注册 hermes kit 命令、专家的系统提示段和各个钩子。

    前两步出错只跳过，不能拦住插件加载；否则一个专家档案的问题会让所有档案都没有套件功能。
    """
    from . import native_ppt

    native_ppt.register(ctx)
    from .office import tools as office_tools
    office_tools.register(ctx)
    llm.set_context(ctx)
    codex.set_context(ctx)
    if codex.ENABLED:
        ctx.register_command(
            "codex", codex.command,
            description="Run a coding task with the current UniWork model",
            args_hint="<task>", argument_mode="text",
        )
    try:
        from pathlib import Path

        from hermes_constants import get_hermes_home

        # The default profile's backend starts right after the desktop login
        # rewrote its model, key and UniAI entry: carry them to the experts.
        expert_sync.sync_on_load(Path(get_hermes_home()))
        # 种草草的后端自己备好自带的小红书程序，不询问用户是否同意。
        from . import xiaohongshu

        xiaohongshu.ensure_builtin(Path(get_hermes_home()))
    except Exception:
        pass
    try:
        from pathlib import Path

        from hermes_constants import get_hermes_home

        # 终端补上 python3 命令和 NODE_PATH（只在 Windows 上，本进程一次）。
        terminal_env.setup(Path(get_hermes_home()))
    except Exception:
        pass
    ctx.register_cli_command(
        "kit",
        "安装和管理 WorkBuddy / UniClaw 的套件与专家",
        cli.setup,
        cli.handle,
        description="把套件装进 profile 的技能和 MCP 配置；把专家装成独立的 profile。",
    )
    for section_id, render in host_rules.SECTIONS:
        ctx.register_system_prompt_section(section_id, render, max_chars=4000)
    ctx.register_system_prompt_section("uniwork.background-tasks", background_rules.section, max_chars=1600)
    ctx.register_system_prompt_section("uniwork.communication", communication_rules.section, max_chars=1600)
    ctx.register_system_prompt_section("uniwork.tool-call", tool_call_rules.section, max_chars=2000)
    ctx.register_hook("pre_llm_call", router.on_pre_llm_call)
    ctx.register_hook("pre_llm_call", terminal_hints.on_pre_llm_call)
    if codex.ENABLED:
        ctx.register_hook("pre_llm_call", codex.on_pre_llm_call)
        ctx.register_hook("post_llm_call", codex.on_post_llm_call)
    ctx.register_hook("pre_tool_call", skill_paths.on_pre_tool_call)
    ctx.register_hook("pre_tool_call", host_hooks.on_pre_tool_call)
    ctx.register_hook("pre_tool_call", package_hooks.on_pre_tool_call)
    ctx.register_hook("pre_tool_call", code_packages.on_pre_tool_call)
    ctx.register_hook("post_tool_call", lambda tool_name="", **kw: package_hooks.on_observed("post_tool_call", tool_name, **kw))
    ctx.register_hook("on_session_start", lambda **kw: package_hooks.on_observed("on_session_start", **kw))
    ctx.register_hook("on_session_end", lambda **kw: package_hooks.on_observed("on_session_end", **kw))
    ctx.register_hook("transform_tool_result", host_hooks.on_transform_tool_result)

    from . import ppt_visual_evidence
    ctx.register_middleware("tool_execution", ppt_visual_evidence.around_call)
    for event, callback in (
        ("pre_api_request", deck_timing.on_pre_api_request),
        ("post_api_request", deck_timing.on_post_api_request),
        ("api_request_error", deck_timing.on_api_request_error),
        ("post_tool_call", deck_timing.on_post_tool_call),
        ("post_llm_call", deck_timing.on_post_llm_call),
    ):
        ctx.register_hook(event, callback)
