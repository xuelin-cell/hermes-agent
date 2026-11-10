"""Reading the gateway config must not materialize every platform adapter.

Enumerating platform ENTRIES resolved every deferred adapter, and each adapter
import pulls a platform SDK: a plain config read cost ~33 s of GIL-holding work
inside the Desktop's interactive window (24 platform SDKs imported at once).
"""

from pathlib import Path

import pytest

from gateway.config import load_gateway_config
from gateway.platform_registry import platform_registry


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    return tmp_path


def test_unconfigured_platform_is_not_imported(home):
    """A platform whose manifest credentials are absent never has to be imported."""
    load_gateway_config()

    assert platform_registry.peek("telegram") is None


def test_configured_platform_is_still_imported(home):
    """A platform the user configured still resolves — its YAML bridge needs the entry."""
    (home / "config.yaml").write_text(
        "telegram:\n  enabled: true\n  bot_token: placeholder-token\n", encoding="utf-8"
    )

    load_gateway_config()

    assert platform_registry.peek("telegram") is not None
