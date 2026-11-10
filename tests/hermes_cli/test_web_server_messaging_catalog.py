"""The messaging platform catalog must not import every platform adapter.

The catalog only needs each platform's label and required env vars — both are in the
plugin manifest. Materializing the adapters to read them imported 24 platform SDKs
(seconds of GIL-holding work) on a page that only lists cards.
"""

from pathlib import Path

import pytest

from gateway.platform_registry import platform_registry
from hermes_cli.web_server_messaging import _messaging_platform_catalog


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    return tmp_path


def test_catalog_does_not_import_platform_adapters(home):
    catalog = _messaging_platform_catalog()

    assert catalog
    assert platform_registry.peek("telegram") is None


def test_catalog_keeps_plugin_platform_metadata(home):
    catalog = {entry["id"]: entry for entry in _messaging_platform_catalog()}

    telegram = catalog["telegram"]
    assert telegram["name"] == "Telegram"
    assert "TELEGRAM_BOT_TOKEN" in telegram["required_env"]
