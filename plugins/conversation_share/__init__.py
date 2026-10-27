"""Cloud opt-in reuses desktop provenance hooks without adding model tools."""

def register(ctx):
    from hermes_cli.config import load_config
    if not load_config().get('cloud_sharing', {}).get('enabled'):
        return
    from importlib import import_module
    # The distribution already ships these hooks; preserve the same observation rules.
    hooks = import_module('apps.desktop.assets.artifact-share-plugin.provenance')
    for name, callback in [('pre_llm_call', hooks.before_turn), ('pre_tool_call', hooks.before_tool),
                           ('post_tool_call', hooks.after_tool), ('post_llm_call', hooks.after_turn)]:
        ctx.register_hook(name, callback)
