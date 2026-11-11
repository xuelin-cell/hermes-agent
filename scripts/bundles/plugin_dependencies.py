"""The Python dependencies of the plugins a build ships.

The desktop bundle stages its Python plugins into the app resources, but their
declared dependencies live outside core's lock. A runtime that cannot find them
asks PM to install them — over the network, at first launch. Bundling them into
the payload's environment removes that install entirely.

The plugin list lives in ``apps/desktop/assets/desktop-plugins.json``; the
staging script reads the same file, so what ships and what gets bundled cannot
drift apart.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

ASSETS = Path("apps/desktop/assets")
MANIFEST = ASSETS / "desktop-plugins.json"
CORE_PLUGINS = Path("plugins")


def personal_plugin_names(source: Path) -> list[str]:
    """The desktop-only plugin assets a build ships, by source directory name."""
    manifest = json.loads((Path(source) / MANIFEST).read_text(encoding="utf-8-sig"))
    names = [entry["source"] for entry in manifest["personal"]]
    if len(set(names)) != len(names):
        raise ValueError(f"duplicate plugin asset in {MANIFEST}")
    return names


def shipped_plugin_dirs(source: Path, personal: list[str] | None = None) -> list[Path]:
    """Every plugin directory whose dependencies must travel with the bundle."""
    source = Path(source)
    core = source / CORE_PLUGINS
    directories = sorted(path for path in core.iterdir() if path.is_dir()) if core.is_dir() else []
    for name in personal or []:
        directory = source / ASSETS / name
        if not (directory / "plugin.yaml").is_file():
            raise ValueError(f"shipped plugin asset has no plugin.yaml: {directory}")
        directories.append(directory)
    return directories


def plugin_requirements(source: Path, personal: list[str] | None = None) -> list[str]:
    """The declared Python requirements of every shipped plugin, deduplicated."""
    from pm.plugin_declarations import read_python_declaration

    requirements: list[str] = []
    for directory in shipped_plugin_dirs(source, personal):
        for spec in read_python_declaration(directory).install_requirements:
            if spec not in requirements:
                requirements.append(spec)
    return requirements


def bundle_plugin_dependencies(*, source: Path, venv_dir: Path, cache: Path,
                               env: dict[str, str], personal: list[str] | None = None) -> int:
    """Install the shipped plugins' Python dependencies into the payload environment.

    A runtime that cannot find a plugin's dependencies asks PM to install them —
    over the network, at first launch. Doing it here ships them instead, so that
    install never happens. The wheels land in the payload's uv cache, so a later
    rebuild still resolves offline.
    """
    requirements = plugin_requirements(source, personal)
    if not requirements:
        return 0
    import sys

    from pm.environment import managed_environment
    from pm.index_config import bridged_index_settings

    environment = managed_environment(
        Path(venv_dir), cache=Path(cache),
        env={**env, **bridged_index_settings(os.environ)},
        explicit=True, output=sys.stderr,
    )
    environment.install_requirements(requirements)
    return len(requirements)
