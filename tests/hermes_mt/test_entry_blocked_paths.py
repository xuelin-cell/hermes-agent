"""入口不往实例转的后端路径：转发器的管理接口、hermes 的「导入备份」，以及 hermes 的「显示环境变量原值」
（浏览器能借它读出 .env 里的设备令牌）。"""

from __future__ import annotations

import pytest
from aiohttp import web
from aiohttp.test_utils import make_mocked_request
from cryptography.fernet import Fernet

from entry.app import Entry
from entry.config import Settings


class _Passed(Exception):
    """没被挡住，走到了后面的企业拦截检查。"""


def _entry(monkeypatch: pytest.MonkeyPatch) -> Entry:
    entry = Entry(Settings(base_path="/hermes", credential_key=Fernet.generate_key().decode(),
                           database_url="postgresql://unused@127.0.0.1:1/unused"))  # 不连库

    async def require(_request: web.Request) -> object:
        return object()

    def gate(_session: object) -> str:
        raise _Passed

    monkeypatch.setattr(entry, "_require", require)
    monkeypatch.setattr(entry, "_gate", gate)
    return entry


def _request(method: str, tail: str) -> web.Request:
    return make_mocked_request(method, f"/hermes/__hermes_backend/{tail}", match_info={"tail": tail})


@pytest.mark.asyncio
@pytest.mark.parametrize("tail", [
    "api/env/reveal", "/api/env/reveal", "api/env/reveal/", "api//env/reveal", "api/env%2Freveal",
    "api%2Fenv%2Freveal", "p/my-bot/api/env/reveal", "__mt/drain", "api/ops/import",
])
async def test_blocked_paths_never_reach_the_instance(monkeypatch: pytest.MonkeyPatch, tail: str) -> None:
    with pytest.raises(web.HTTPNotFound):
        await _entry(monkeypatch).backend(_request("POST", tail))


@pytest.mark.asyncio
@pytest.mark.parametrize("tail", ["api/env", "api/sessions", "api/env/reveal-note", "__mt_user/terminal"])
async def test_other_paths_go_on_to_the_gate(monkeypatch: pytest.MonkeyPatch, tail: str) -> None:
    with pytest.raises(_Passed):
        await _entry(monkeypatch).backend(_request("GET", tail))
