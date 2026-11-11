"""The shipped plugins' Python dependencies travel with the bundle.

A runtime that cannot find a plugin's declared dependency asks PM to install
it — over the network, at first launch. The build collects those requirements
so they can be bundled instead; these tests pin that contract.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from scripts.bundles.plugin_dependencies import (
    personal_plugin_names,
    plugin_requirements,
    shipped_plugin_dirs,
)

ROOT = Path(__file__).resolve().parents[2]


def test_every_shipped_asset_exists_in_the_checkout():
    for name in personal_plugin_names(ROOT):
        assert (ROOT / "apps/desktop/assets" / name / "plugin.yaml").is_file()


def test_every_shipped_plugin_dependency_is_collected():
    from pm.plugin_declarations import read_python_declaration

    personal = personal_plugin_names(ROOT)
    collected = plugin_requirements(ROOT, personal)

    for directory in shipped_plugin_dirs(ROOT, personal):
        for spec in read_python_declaration(directory).install_requirements:
            assert spec in collected
    assert len(collected) == len(set(collected))


def test_the_desktop_assets_are_not_collected_without_the_desktop_build():
    # The CLI payload ships core's plugins only; their dependencies must not
    # pull the desktop's own libraries into that bundle.
    desktop = plugin_requirements(ROOT, personal_plugin_names(ROOT))
    core = plugin_requirements(ROOT)

    assert set(core) < set(desktop)


def test_an_asset_without_a_manifest_is_refused(tmp_path):
    (tmp_path / "plugins").mkdir()

    with pytest.raises(ValueError):
        shipped_plugin_dirs(tmp_path, ["missing-plugin"])
