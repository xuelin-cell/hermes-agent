"""Plugin discovery is the longest stage of a Desktop `serve` boot and must not gate the bind.

Behavior contract: the Desktop-owned backend sweeps plugins in the background (the auth gate and
every synchronous registry reader hold their own join), while every other dashboard/serve entry
keeps the blocking sweep it has always had.
"""

from __future__ import annotations

import types

import hermes_constants
from hermes_cli import main as main_mod
from hermes_cli import mcp_startup
from hermes_cli import plugins as plugins_mod


def _stub_runtime(monkeypatch) -> None:
    monkeypatch.setattr(main_mod, "_require_dashboard_web_deps", lambda: None)
    monkeypatch.setattr(main_mod, "_sync_bundled_skills_quietly", lambda: None)
    monkeypatch.setattr(main_mod, "_resolve_dashboard_web_dist", lambda *a, **k: None)
    monkeypatch.setattr(
        mcp_startup, "defer_background_mcp_discovery", lambda **kwargs: None
    )


def _desktop_env(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.setenv("HERMES_DASHBOARD_SESSION_TOKEN", "test-session-token")


def test_desktop_headless_serve_backgrounds_plugin_discovery(monkeypatch):
    _stub_runtime(monkeypatch)
    _desktop_env(monkeypatch)

    calls: list[str] = []
    monkeypatch.setattr(
        plugins_mod, "start_background_plugin_discovery", lambda: calls.append("background")
    )
    monkeypatch.setattr(
        plugins_mod, "discover_plugins", lambda *_a, **_k: calls.append("sync")
    )

    after_bind = main_mod._dashboard_prepare_runtime(
        types.SimpleNamespace(skip_build=True), headless_backend=True
    )

    assert after_bind is True
    assert calls == ["background"], "the Desktop backend must not block the bind on plugins"


def test_standalone_dashboard_still_loads_plugins_before_the_bind(monkeypatch):
    _stub_runtime(monkeypatch)
    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.delenv("HERMES_DASHBOARD_SESSION_TOKEN", raising=False)

    calls: list[str] = []
    monkeypatch.setattr(
        plugins_mod, "start_background_plugin_discovery", lambda: calls.append("background")
    )
    monkeypatch.setattr(
        plugins_mod, "discover_plugins", lambda *_a, **_k: calls.append("sync")
    )

    after_bind = main_mod._dashboard_prepare_runtime(
        types.SimpleNamespace(skip_build=True), headless_backend=True
    )

    assert after_bind is False
    assert calls == ["sync"], "a non-Desktop serve keeps the blocking sweep (gated binds need it)"


def test_background_discovery_runs_under_the_arming_threads_context(monkeypatch):
    """A bare thread starts with an empty context; register() bodies must still see the profile."""
    seen: list[str | None] = []

    class _Manager:
        _discovered = False

        def discover_and_load(self) -> None:
            seen.append(hermes_constants.get_hermes_home_override())

    monkeypatch.setattr(plugins_mod, "_background_discovery_thread", None)
    monkeypatch.setattr(plugins_mod, "get_plugin_manager", lambda: _Manager())
    monkeypatch.setattr(plugins_mod, "_persist_plugin_toolset_keys", lambda: None)

    hermes_constants.set_hermes_home_override("C:/tmp/profile-with-plugins")
    try:
        plugins_mod.start_background_plugin_discovery()
        thread = plugins_mod._background_discovery_thread
        assert thread is not None
        thread.join(timeout=30)
    finally:
        hermes_constants.set_hermes_home_override(None)

    assert seen == ["C:/tmp/profile-with-plugins"]


def test_gated_bind_waits_for_the_background_sweep_before_failing_closed(monkeypatch):
    import hermes_cli.dashboard_auth as dashboard_auth
    import hermes_cli.web_server as web_server

    provider = types.SimpleNamespace(name="password")
    remaining = [[], [provider]]

    monkeypatch.setattr(web_server, "_dashboard_public_hosts", lambda: frozenset())
    monkeypatch.setattr(web_server, "_desktop_loopback_auth_exempt", lambda *a, **k: False)
    monkeypatch.setattr(web_server, "should_require_dashboard_auth", lambda *a, **k: True)
    monkeypatch.setattr(
        dashboard_auth, "list_providers", lambda: remaining.pop(0) if remaining else [provider]
    )
    waits: list[bool] = []
    monkeypatch.setattr(
        plugins_mod, "wait_for_plugin_discovery", lambda *a, **k: waits.append(True)
    )

    web_server._configure_auth_gate("0.0.0.0", False, None, None)

    assert waits == [True], "a provider-registering sweep still running must be awaited"
