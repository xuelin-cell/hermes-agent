"""Prepare declared dependencies through PM before the desktop backend starts."""

from __future__ import annotations
import os
from pathlib import Path
import sys

if __name__ == "__main__":
    if (
        len(sys.argv) != 2
        or not os.environ.get("HERMES_HOME")
        or Path(sys.argv[1]).resolve() != Path(os.environ["HERMES_HOME"]).resolve()
    ):
        raise RuntimeError("Explicit account Home is required")
    import hermes_bootstrap  # noqa: F401
    import importlib.metadata
    import hermes_yaml as yaml
    from packaging.requirements import Requirement
    from hermes_cli.config import read_user_config_raw
    import pm

    current = read_user_config_raw()
    web = current.get("web") or {}
    selected_fetch = web.get("extract_backend") or web.get("backend")
    # 其他 Provider 和远端 UniCrawl 不依赖本机正文解析器或 Chromium。
    if (
        "unisearch" not in current.get("plugins", {}).get("disabled", [])
        and selected_fetch == "builtin_parse"
    ):
        declarations = yaml.safe_load(
            Path(__file__).with_name("plugin.yaml").read_text(encoding="utf-8")
        )["python_dependencies"]
        missing = False
        for spec in declarations:
            requirement = Requirement(spec)
            try:
                missing |= (
                    importlib.metadata.version(requirement.name)
                    not in requirement.specifier
                )
            except importlib.metadata.PackageNotFoundError:
                missing = True
        if missing:
            from pm.plugin_inputs import Candidates

            pm.sync_venv(explicit=True, plugins=Candidates([Path(__file__).parent]))
        # Chromium remains managed by Hermes PM, never by raw playwright/pip commands.
        pm.ensure("chromium")
