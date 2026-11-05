"""Automatic review requires explicit per-profile opt-in."""

from agent.background_review import is_background_review_enabled, load_background_review_settings
from hermes_cli.config_defaults import DEFAULT_CONFIG


def test_automatic_review_requires_opt_in(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert DEFAULT_CONFIG["auxiliary"]["background_review"]["enabled"] is False
    assert load_background_review_settings()[0] is False
    assert is_background_review_enabled({}) is False
    assert is_background_review_enabled({"enabled": True}) is True
    assert is_background_review_enabled({"enabled": False}) is False
