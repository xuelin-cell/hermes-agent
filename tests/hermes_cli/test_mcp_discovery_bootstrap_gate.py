"""The deferred MCP discovery must not collide with the boot window.

Two invariants this file pins:

1. The deferred discovery fires under the ARMING thread's context. A bare
   ``threading.Timer`` starts with an empty context, so the profile-scoped
   ``HERMES_HOME`` override the arming thread carries used to be invisible to
   it: the discovery ran for the launch profile instead of the profile that
   armed it, and silently found no servers.
2. The discovery's heavy phase (SDK import, schema parsing, tool registration)
   waits for a quiet gap in the server's request traffic. On top of a client's
   first request burst it starves the loop that has to answer those requests,
   and the whole boot window degrades into client timeouts.
"""

from __future__ import annotations

import logging
import threading
import time

import hermes_cli.mcp_startup as mcp_startup
from hermes_constants import set_hermes_home_override


def _reset_discovery_state(monkeypatch):
    monkeypatch.setattr(mcp_startup, "_mcp_discovery_started", set())
    monkeypatch.setattr(mcp_startup, "_mcp_discovery_thread", {})
    monkeypatch.setattr(mcp_startup, "_mcp_discovery_deferred", None)
    monkeypatch.setattr(mcp_startup, "_idle_gate", None)


def test_deferred_discovery_fires_under_the_arming_threads_context(monkeypatch):
    """The profile override the arming thread carries must reach the discovery."""
    _reset_discovery_state(monkeypatch)
    seen: list[str | None] = []
    monkeypatch.setattr(
        mcp_startup,
        "start_background_mcp_discovery",
        lambda *, logger, thread_name: seen.append(mcp_startup.hermes_home_key()),
    )

    set_hermes_home_override("C:/tmp/profile-with-mcp")
    try:
        mcp_startup.defer_background_mcp_discovery(
            logger=logging.getLogger("test"), thread_name="t", delay=None
        )
        # A bare Timer thread would carry an empty context here.
        mcp_startup.start_deferred_mcp_discovery_now()
    finally:
        set_hermes_home_override(None)

    assert seen == [mcp_startup.hermes_home_key("C:/tmp/profile-with-mcp")]


def test_discovery_waits_for_a_quiet_gap_before_its_heavy_phase(monkeypatch):
    """The heavy phase must not start while the server is serving requests."""
    _reset_discovery_state(monkeypatch)
    order: list[str] = []
    busy = threading.Event()
    busy.set()

    monkeypatch.setattr(mcp_startup, "_idle_gate", busy.is_set)
    monkeypatch.setattr(mcp_startup, "_has_configured_mcp_servers", lambda: True)
    monkeypatch.setattr(
        mcp_startup,
        "_discover_mcp_tools_without_interactive_oauth",
        lambda: order.append("discover"),
    )
    monkeypatch.setattr(mcp_startup, "_any_mcp_connected", lambda: True)

    mcp_startup.start_background_mcp_discovery(logger=logging.getLogger("test"), thread_name="t")
    try:
        # Busy: the discovery is armed but must not have started its work.
        time.sleep(0.4)
        assert order == []
        busy.clear()
        deadline = time.monotonic() + 5.0
        while not order and time.monotonic() < deadline:
            time.sleep(0.05)
    finally:
        busy.clear()

    assert order == ["discover"]
