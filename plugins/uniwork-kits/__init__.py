"""UniWork kits & experts for Hermes.

Hermes core does not know WorkBuddy / UniClaw packages. This plugin unpacks
them into what Hermes already has — skills, ``mcp_servers``, profiles and
``SOUL.md`` — and adds three things on top:

* ``hermes kit ...`` — inspect / install / seed / list / enable / disable /
  uninstall / triggers / config (see :mod:`.cli`);
* cache-safe system prompt sections carrying each expert's host rules
  (:mod:`.host_rules`), empty for every profile that is not an expert;
* a ``pre_llm_call`` hook suggesting matching kit skills in ordinary
  conversations, and PPT picture rules that name the media slot
  (:mod:`.router`, :mod:`.media_slot`).

Enable with ``hermes plugins enable uniwork-kits``. Expert profiles created by
``hermes kit install`` enable it for themselves.
"""

from __future__ import annotations

from . import cli, host_rules, llm, package_hooks, router


def register(ctx) -> None:
    llm.set_context(ctx)
    ctx.register_cli_command(
        "kit",
        "安装和管理 WorkBuddy / UniClaw 的套件与专家",
        cli.setup,
        cli.handle,
        description="把套件装进 profile 的技能和 MCP 配置；把专家装成独立的 profile。",
    )
    for section_id, render in host_rules.SECTIONS:
        ctx.register_system_prompt_section(section_id, render, max_chars=4000)
    ctx.register_hook("pre_llm_call", router.on_pre_llm_call)
    ctx.register_hook("pre_tool_call", package_hooks.on_pre_tool_call)
    ctx.register_hook("post_tool_call", lambda tool_name="", **kw: package_hooks.on_observed("post_tool_call", tool_name))
    ctx.register_hook("on_session_start", lambda **kw: package_hooks.on_observed("on_session_start"))
    ctx.register_hook("on_session_end", lambda **kw: package_hooks.on_observed("on_session_end"))
    ctx.register_hook("transform_tool_result", package_hooks.on_transform_tool_result)
