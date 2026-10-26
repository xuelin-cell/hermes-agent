"""Invariants for the version helper behind the bump-version skill."""
from __future__ import annotations

import json

from scripts.releases.set_version import (
    bump,
    set_package_json,
    set_package_lock,
    set_pyproject,
    set_uv_lock,
    validate,
)


def test_setters_change_only_the_version_field() -> None:
    pyproject = '[project]\nname = "hermes-agent"\nversion = "1.0.2"\n\n[tool.foo]\nversion = "9.9.9"\n'
    assert set_pyproject(pyproject, "1.0.3") == pyproject.replace('version = "1.0.2"', 'version = "1.0.3"', 1)

    package = '{\n  "name": "hermes",\n  "version": "1.0.2",\n  "dependencies": {"x": "1.0.2"}\n}\n'
    updated_package = set_package_json(package, "1.0.3")
    assert json.loads(updated_package)["version"] == "1.0.3"
    assert json.loads(updated_package)["dependencies"]["x"] == "1.0.2"

    lock = (
        '{\n  "packages": {\n    "": {"version": "1.0.0"},\n'
        '    "apps/desktop": {\n      "name": "hermes",\n      "version": "1.0.2",\n'
        '      "dependencies": {}\n    },\n    "node_modules/x": {"version": "1.0.2"}\n  }\n}\n'
    )
    updated_lock = json.loads(set_package_lock(lock, "1.0.3"))
    assert updated_lock["packages"]["apps/desktop"]["version"] == "1.0.3"
    assert updated_lock["packages"]["node_modules/x"]["version"] == "1.0.2"
    assert updated_lock["packages"][""]["version"] == "1.0.0"

    uv = (
        '[[package]]\nname = "other"\nversion = "1.0.2"\n\n'
        '[[package]]\nname = "hermes-agent"\nversion = "1.0.2"\nsource = { editable = "." }\n'
    )
    updated_uv = set_uv_lock(uv, "1.0.3")
    assert 'name = "hermes-agent"\nversion = "1.0.3"' in updated_uv
    assert 'name = "other"\nversion = "1.0.2"' in updated_uv


def test_validate_reports_a_split_version(tmp_path) -> None:
    (tmp_path / "apps/desktop").mkdir(parents=True)
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "hermes-agent"\nversion = "1.0.2"\n', encoding="utf-8"
    )
    (tmp_path / "apps/desktop/package.json").write_text('{"version": "1.0.2"}', encoding="utf-8")
    (tmp_path / "package-lock.json").write_text(
        '{"packages": {"apps/desktop": {"version": "1.0.1"}}}', encoding="utf-8"
    )
    (tmp_path / "uv.lock").write_text(
        '[[package]]\nname = "hermes-agent"\nversion = "1.0.2"\n', encoding="utf-8"
    )

    errors = validate(tmp_path)
    assert any("version mismatch" in error for error in errors)


def test_bump_advances_the_requested_component() -> None:
    assert bump("1.0.2", "patch") == "1.0.3"
    assert bump("1.0.2", "minor") == "1.1.0"
    assert bump("1.0.2", "major") == "2.0.0"
