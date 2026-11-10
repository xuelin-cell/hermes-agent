"""前端报来的耗时（entry/timing_routes.py）：两个版本都收，只收环节名、秒数和短标签，记进审计 client.timing。"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.fernet import Fernet

from entry import timing_routes
from entry.app import build_app
from entry.config import Settings
from entry.timing_routes import TimingRoutes, clean

GOOD = {"kind": "bot.create", "seconds": 13.04, "steps": {"create": 2.2, "agent": 6.8, "first_token": 3.0},
        "labels": {"model": "deepseek-v4-flash", "bot": True, "attachments": 0}}


def test_clean_keeps_names_seconds_and_short_labels_only() -> None:
    assert clean(GOOD) == GOOD
    noisy = {**GOOD, "labels": {"model": "m\x00" + "x" * 100, "bad key": "x", "nested": {"a": 1}, "slow_notice": False},
             "extra": "dropped"}
    kept = clean(noisy)
    assert kept is not None and set(kept) == {"kind", "seconds", "steps", "labels"}
    assert kept["labels"] == {"model": "m" + "x" * 63, "slow_notice": False}


@pytest.mark.parametrize("bad", [
    {**GOOD, "kind": "anything"},                                   # 只收认得的几类
    {**GOOD, "seconds": -1},
    {**GOOD, "seconds": 99999},
    {**GOOD, "seconds": True},
    {**GOOD, "steps": {"Create": 1}},                               # 环节名只许小写字母、数字、下划线
    {**GOOD, "steps": {"create": "2"}},
    {**GOOD, "steps": {f"s{i}": 1 for i in range(13)}},             # 环节太多
    {**GOOD, "labels": {f"l{i}": 1 for i in range(9)}},             # 标签太多
    [GOOD],
])
def test_clean_rejects_malformed_records(bad) -> None:
    assert clean(bad) is None


class _Entry:
    def __init__(self, signed_in: bool = True) -> None:
        self.signed_in = signed_in
        self.audits: list[tuple[str, str, dict]] = []
        self.store = SimpleNamespace(write_audit=self._write)

    async def _write(self, user_id, event_type, details=None):
        self.audits.append((user_id, event_type, details))

    async def _require(self, request):
        if not self.signed_in:
            raise web.HTTPUnauthorized(text="not logged in")
        return SimpleNamespace(user_id="ent:t1:u1", sid="s1")


async def _client(entry: _Entry) -> TestClient:
    app = web.Application()
    app.router.add_post("/agents/api/__entry/timing", TimingRoutes(entry).handle)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client


@pytest.mark.asyncio
async def test_signed_in_report_is_written_to_the_audit_log() -> None:
    entry = _Entry()
    client = await _client(entry)
    try:
        response = await client.post("/agents/api/__entry/timing", json=GOOD)
        assert response.status == 204
        assert entry.audits == [("ent:t1:u1", "client.timing", GOOD)]
        assert (await client.post("/agents/api/__entry/timing", json={**GOOD, "kind": "x"})).status == 400
        assert (await client.post("/agents/api/__entry/timing", data=b"{not json")).status == 400
        assert (await client.post("/agents/api/__entry/timing", data=b"x" * 5000)).status == 413
        assert len(entry.audits) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_signed_out_and_flooding_reports_are_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    client = await _client(_Entry(signed_in=False))
    try:
        assert (await client.post("/agents/api/__entry/timing", json=GOOD)).status == 401
    finally:
        await client.close()
    monkeypatch.setattr(timing_routes, "PER_MINUTE", 3)
    entry = _Entry()
    client = await _client(entry)
    try:
        statuses = [(await client.post("/agents/api/__entry/timing", json=GOOD)).status for _ in range(5)]
        assert statuses == [204, 204, 204, 429, 429] and len(entry.audits) == 3
    finally:
        await client.close()


def test_both_editions_take_timing_reports() -> None:
    def routes(**settings) -> set[str]:
        app = build_app(Settings(credential_key=Fernet.generate_key().decode(), database_url="postgresql://unused/db",
                                 **settings))
        return {resource.canonical for resource in app.router.resources()}

    for edition in (routes(), routes(uniwork_server="http://platform.test", client_features="none")):
        assert any(route.endswith("/__entry/timing") for route in edition)
