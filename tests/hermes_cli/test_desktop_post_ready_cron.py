"""Desktop `serve`: the cron ticker starts behind the READY sentinel.

The ticker's import chain (``cron.scheduler_provider`` and the store/adapter modules under
it) is cold-start expensive and runs on its own thread, so starting it before the bind only
stole GIL from the path to the sentinel. The desktop never waits for the ticker — it fires
jobs on its own 60s cadence — so it starts once the sentinel is out, and only after a quiet
request window so the import burst cannot starve the first hydration reads.
"""

from __future__ import annotations

import threading

import pytest


def _desktop_env(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.setenv("HERMES_DASHBOARD_SESSION_TOKEN", "desktop-spawn-token")


def test_lifespan_does_not_start_the_cron_ticker(monkeypatch):
    """The lifespan must not start the ticker: that work belongs behind the sentinel.

    Asserting "the ticker runs" would not catch a revert to the pre-sentinel start, which
    is exactly the regression this guards.
    """
    from starlette.testclient import TestClient

    import hermes_cli.web_server as ws

    started: list[str] = []

    monkeypatch.setattr(ws, "_warm_gateway_module", lambda: None)
    monkeypatch.setattr(ws, "_start_desktop_cron_ticker", lambda *_args: started.append("ticker"))
    _desktop_env(monkeypatch)

    with TestClient(ws.app, raise_server_exceptions=False):
        # The lifespan ran (the socket is up) but the sentinel was never written.
        assert started == [], (
            "the cron ticker started inside the lifespan — it must wait for the READY "
            "sentinel so its cold import chain does not hold the GIL on the way to it"
        )


def test_ticker_starts_after_the_sentinel(monkeypatch):
    """Behind the sentinel the ticker starts, and it waits for a quiet window first."""
    import hermes_cli.web_server as ws

    started = threading.Event()
    order: list[str] = []

    def _fake_ticker(stop_event, interval=60):
        order.append("ticker")
        started.set()

    def _fake_quiet_window():
        order.append("quiet")

    monkeypatch.setattr(ws, "_start_desktop_cron_ticker", _fake_ticker)
    monkeypatch.setattr(
        "hermes_cli.mcp_startup.wait_for_quiet_request_window", _fake_quiet_window
    )
    _desktop_env(monkeypatch)

    stop = threading.Event()
    ws.app.state.desktop_cron_stop = stop
    try:
        ws._start_desktop_cron_ticker_after_ready()
        assert started.wait(timeout=10.0), "the cron ticker never started behind the sentinel"
        assert order == ["quiet", "ticker"], (
            "the ticker must wait for a quiet request window before its import burst"
        )
    finally:
        stop.set()
        del ws.app.state.desktop_cron_stop


def test_ticker_does_not_start_when_the_backend_is_shutting_down(monkeypatch):
    """A shutdown that lands before the ticker starts must not launch a ticker."""
    import hermes_cli.web_server as ws

    started: list[str] = []

    monkeypatch.setattr(ws, "_start_desktop_cron_ticker", lambda *_args: started.append("ticker"))
    monkeypatch.setattr(
        "hermes_cli.mcp_startup.wait_for_quiet_request_window", lambda: None
    )
    _desktop_env(monkeypatch)

    stop = threading.Event()
    stop.set()
    ws.app.state.desktop_cron_stop = stop
    try:
        ws._start_desktop_cron_ticker_after_ready()
        # The thread is a daemon: give it the moment it needs to notice the stop.
        threading.Event().wait(timeout=0.5)
        assert started == [], "a ticker was started on a backend that is already shutting down"
    finally:
        del ws.app.state.desktop_cron_stop


def test_no_ticker_without_a_desktop_stop_event(monkeypatch):
    """A non-desktop backend has no stop event, so nothing is started."""
    import hermes_cli.web_server as ws

    started: list[str] = []

    monkeypatch.setattr(ws, "_start_desktop_cron_ticker", lambda *_args: started.append("ticker"))
    if hasattr(ws.app.state, "desktop_cron_stop"):
        del ws.app.state.desktop_cron_stop

    ws._start_desktop_cron_ticker_after_ready()
    threading.Event().wait(timeout=0.5)
    assert started == [], "the cron ticker started without a desktop stop event"
