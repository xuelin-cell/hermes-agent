"""Real loader/dispatch tests for non-shell adapters and untrusted tool contracts."""

import json

from hermes_cli.plugins import PluginContext, get_plugin_manager
from hermes_cli.plugins_manifest import PluginManifest
from model_tools import handle_function_call
from tests.plugins.test_security_guardrail import profile
from tools.registry import registry


def test_real_read_search_and_cron_list(tmp_path):
    root = tmp_path / "workspace"
    (root / "protected").mkdir(parents=True)
    (root / "ordinary.txt").write_text("adapter-needle\n", encoding="utf-8")
    seen = []
    with profile(tmp_path / "home", root) as task_id:
        ctx = PluginContext(PluginManifest(name="prepared-observer"), get_plugin_manager())
        registration = ctx.register_hook("pre_tool_execute", lambda execution: seen.append(execution))
        try:
            for name, args in (
                ("read_file", {"path": "ordinary.txt"}),
                ("search_files", {"pattern": "adapter-needle", "path": ".", "target": "content"}),
                ("search_files", {"pattern": "*.txt", "target": "files"}),
                ("cronjob_manage", {"action": "list"}),
            ):
                result = json.loads(handle_function_call(name, args, task_id=task_id,
                    tool_call_id="real-call-1", turn_id="real-turn-1"))
                assert not result.get("error"), result
            assert len(seen) == 4
            assert seen[0].targets[0].path == str(root / "ordinary.txt")
            assert seen[1].targets[0].path == str(root)
            assert all(execution.tool_call_id == "real-call-1" and execution.turn_id == "real-turn-1" for execution in seen)
        finally:
            registration.dispose()


def test_registry_boundary_checks_unknown_code_and_all_used_urls(tmp_path):
    root = tmp_path / "workspace"
    (root / "protected").mkdir(parents=True)
    with profile(tmp_path / "home", root) as task_id:
        calls = []
        # A plugin-owned tool proves the generic final-dispatch contract without
        # contacting a provider. Built-in URL rejection is tested separately.
        registry.register(name="guardrail_probe", toolset="guardrail-test", schema={"name": "guardrail_probe"},
                          handler=lambda args: calls.append(args) or json.dumps({"ok": True}))
        try:
            blocked = json.loads(registry.dispatch("guardrail_probe", {"code": "print('harmless')"}, task_id=task_id))
            assert "common.tool.unknown_exec_field" in blocked["error"], blocked
            assert not calls
            allowed = json.loads(registry.dispatch("guardrail_probe", {"text": "ordinary"}, task_id=task_id))
            assert allowed["ok"] and calls == [{"text": "ordinary"}]
        finally:
            registry.deregister("guardrail_probe")
        for name, args in (
            ("web_extract", {"urls": ["https://example.com", "https://synthetic-user:synthetic-password@example.com"]}),
            ("browser_navigate", {"url": "file:///test.txt"}),
            ("web_search", {"query": ""}),
            ("web_search", {"query": "synthetic", "allowed_domains": ["example.com"], "blocked_domains": ["example.org"]}),
        ):
            result = json.loads(handle_function_call(name, args, task_id=task_id))
            assert "security-guardrail" in result["error"], result
            assert "synthetic-password" not in result["error"]


def test_web_allow_reaches_registered_provider_with_checked_normalized_urls(tmp_path, monkeypatch):
    from agent.web_search_provider import WebSearchProvider
    from tools import web_tools
    calls = []
    class LocalProvider(WebSearchProvider):
        name = "guardrail-local-fixture"
        def is_available(self):
            return True
        def supports_extract(self):
            return True
        def search(self, query, limit=5):
            calls.append(("search", query))
            return {"success": True, "data": {"web": [{"title": "fixture", "url": "https://example.com", "description": "fixture", "position": 1}]}}
        def extract(self, urls, **kwargs):
            calls.append(("extract", urls))
            return [{"url": url, "title": "fixture", "content": "local provider content", "raw_content": ""} for url in urls]
    async def safe(url):
        return True
    # DNS and a vendor are deliberately replaced by a local provider. The
    # loader, Guardrail, registry, URL normalizer and real web tool all run.
    monkeypatch.setattr(web_tools, "async_is_safe_url", safe)
    root = tmp_path / "workspace"
    (root / "protected").mkdir(parents=True)
    home = tmp_path / "home"
    with profile(home, root) as task_id:
        config = json.loads((home / "config.yaml").read_text(encoding="utf-8"))
        config["web"] = {"backend": "guardrail-local-fixture", "keyless_fallback": False}
        (home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
        ctx = PluginContext(PluginManifest(name="web-fixture"), get_plugin_manager())
        registration = ctx.register_web_search_provider(LocalProvider())
        seen = []
        observer = ctx.register_hook("pre_tool_execute", lambda execution: seen.append(execution))
        try:
            result = json.loads(handle_function_call("web_search", {"query": "synthetic provider query"}, task_id=task_id))
            assert result["success"], result
            result = json.loads(handle_function_call("web_extract", {"urls": [{"href": " https:// example.com/a "}]}, task_id=task_id))
            assert not result.get("error"), result
            assert calls == [("search", "synthetic provider query"), ("extract", ["https://example.com/a"])]
            extracted = [execution for execution in seen if execution.tool_name == "web_extract"]
            assert len(extracted) == 1 and tuple(extracted[0].arguments["urls"]) == ("https://example.com/a",)
        finally:
            observer.dispose()
            registration.dispose()
