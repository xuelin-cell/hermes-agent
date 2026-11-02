"""Desktop bootstrap writer. stdin contains validated non-secret cloud configuration only."""

from __future__ import annotations
import json
import sys
import os
from pathlib import Path
from urllib.parse import urlsplit


# 原生锁与原子写入只更新套件字段，保留其他Provider及访问策略。
def apply(remote: dict | None) -> None:
    """Apply owned fields atomically; missing remote data preserves the previous snapshot."""
    from tools.url_safety import sensitive_query_param_name
    from hermes_cli import config
    from hermes_cli.plugins_state import _locked_plugin_state

    with _locked_plugin_state(config.get_config_path()), config._CONFIG_LOCK:
        current = config.read_user_config_raw()
        before = json.dumps(current, sort_keys=True)
        plugins = current.setdefault("plugins", {})
        settings = (
            plugins
            .setdefault("entries", {})
            .setdefault("unisearch", {})
            .setdefault("settings", {})
        )
        settings.setdefault("backend", "tencent")
        if remote is not None:
            mapping = {
                "unisearch_backend": "backend",
                "unisearch_url": "url",
                "unisearch_display_name": "display_name",
            }
            for source, target in mapping.items():
                if source not in remote:
                    continue
                value = remote[source]
                if not isinstance(value, str):
                    raise ValueError("Invalid UniSearch configuration")
                if target == "backend" and value not in {"bocha", "tencent"}:
                    raise ValueError("Unknown UniSearch backend")
                if target == "url" and value:
                    parsed = urlsplit(value)
                    if (
                        parsed.scheme != "https"
                        or not parsed.hostname
                        or parsed.username
                        or parsed.password
                        or parsed.fragment
                        or sensitive_query_param_name(value)
                    ):
                        raise ValueError("Invalid UniSearch URL")
                settings[target] = value
            if isinstance(remote.get("version"), str):
                settings["remote_version"] = remote["version"]
        web = current.setdefault("web", {})
        enabled_here = "unisearch" not in plugins.get("disabled", [])
        if remote is not None and "fetch_provider" in remote:
            if remote["fetch_provider"] not in {"builtin_parse", "unicrawl"}:
                raise ValueError("Unknown fetch provider")
            if enabled_here and (
                not web.get("extract_backend")
                or web["extract_backend"] in {"builtin_parse", "unicrawl"}
            ):
                web["extract_backend"] = remote["fetch_provider"]
        if enabled_here and not web.get("extract_backend") and not web.get("backend"):
            web["extract_backend"] = "builtin_parse"
        # 套件缓存独立配置；不写入或猜测恢复 Profile 的原生策略开关。
        settings.setdefault("cache_enabled", True)
        settings.setdefault("cache_ttl_minutes", 5)
        # Preserve an explicit provider choice, including the shared backend selector.
        if (
            "unisearch" not in plugins.get("disabled", [])
            and not web.get("search_backend")
            and not web.get("backend")
        ):
            web["search_backend"] = "unisearch"
        if "unisearch" not in plugins.get("disabled", []):
            enabled = plugins.setdefault("enabled", [])
            if "unisearch" not in enabled:
                enabled.append("unisearch")
        if json.dumps(current, sort_keys=True) != before:
            config.atomic_config_write(config.get_config_path(), current)


if __name__ == "__main__":
    # Bind the account before bootstrap can select or prepare its dependency environment.
    if (
        len(sys.argv) != 2
        or not os.environ.get("HERMES_HOME")
        or Path(os.environ["HERMES_HOME"]).resolve() != Path(sys.argv[1]).resolve()
    ):
        raise RuntimeError("Explicit account Home is required")
    import hermes_bootstrap  # noqa: F401 -- same PM activation as the backend entry point

    apply(json.load(sys.stdin))
