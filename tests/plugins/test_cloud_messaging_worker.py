"""The cloud relay worker serves one binding on the default profile, never as a host multiplexer.

Regression: once multiplex became the gateway default, an instance with expert profiles started the
relay worker multiplexed. It then skipped the WeChat relay adapter ("no bot credential in this
profile's secrets"; a relay has none), never became ready, and held the instance's messaging lock,
so a 5G message queued behind it timed out at the 180 s wake. It also started every expert profile.
"""
from pathlib import Path

import pytest

import hermes_constants
from gateway.config import load_gateway_config
from hermes_cli import gateway_migrate as gm
from hermes_cli import gateway_multiplex_mode as mode

RELAY = """\
cloud_messaging:
  enabled: true
  transport: entry-forward-relay-v1
  platform: weixin
  bot_id: bot@im.bot
  binding_id: binding
  revision: 2
  upgrade_secret: fixture
cloud_messaging_delivery:
  enabled: true
platforms:
  weixin: {enabled: true}
  uniagentgate: {enabled: true}
"""


@pytest.fixture
def instance_home(tmp_path, monkeypatch):
    root = tmp_path / "hermes"
    (root / "profiles/douyin-strategist").mkdir(parents=True)
    (root / "config.yaml").write_text(RELAY, encoding="utf-8")
    (root / "profiles/douyin-strategist/config.yaml").write_text(
        "cloud_messaging_delivery:\n  enabled: true\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.delenv("GATEWAY_MULTIPLEX_PROFILES", raising=False)
    monkeypatch.setattr(hermes_constants, "_default_hermes_root_memo", None)
    monkeypatch.setattr(gm, "_installed_services", lambda home: [])
    monkeypatch.setattr(gm, "_live_gateway_pid", lambda home: None)
    monkeypatch.setattr(gm, "_host_supports_migration", lambda: None)
    return root


def test_relay_worker_keeps_its_token_platform_on_the_default_profile(instance_home):
    # The precondition of the bug: with an expert profile on disk the gateway default multiplexes.
    assert mode.resolve_multiplex_mode(load_gateway_config()).enabled is True

    from plugins.cloud_messaging import worker
    runner = worker.build_runner()
    assert runner.config.multiplex_profiles is False
    assert runner._multiplex_on() is False  # so no "no bot credential" skip for the relay adapter
    assert [platform.value for platform in runner.config.platforms] == ["weixin"]
