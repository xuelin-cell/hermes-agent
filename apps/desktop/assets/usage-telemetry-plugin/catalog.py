"""Adapt UniWork's product registries on the disk worker, never infer private IDs."""

import json
from pathlib import Path
import re

from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

from .protocol import resource, text

SHARED = {
    "https://mcp.notion.com/mcp": "notion", "https://mcp.slack.com/mcp": "slack",
    "https://mcp.atlassian.com/v1/sse": "atlassian", "https://mcp.asana.com/sse": "asana",
    "https://api.githubcopilot.com/mcp": "github", "https://mcp.linear.app/sse": "linear",
}
CONNECTORS = {"qq_mail", "netease_mail", "amap", "wps_mcp", "youdao_note", "ima",
              "qcc_mcp", "tianyancha_mcp", "eastmoney_mcp", "ifind_mcp", "aminer", "wecom_bot"}


def read_json(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def read_config(home):
    parser = YAML(typ="safe", pure=True)
    parser.version = (1, 1)
    value = parser.load((home / "config.yaml").read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else {}


class Catalog:
    def __init__(self, home):
        self.home = Path(home)

    def plugins(self):
        return read_json(self.home / "imported-plugins" / "index.json").get("plugins", {})

    def expert(self):
        for name, entry in self.plugins().items():
            if isinstance(entry, dict) and entry.get("kind") == "expert" and entry.get("self"):
                return resource(name, entry.get("display_name"))
        return None

    def models(self, snapshots):
        """Only map a uniquely managed endpoint; custom credentials must not borrow its package."""
        try:
            config = read_config(self.home)
        except (OSError, ValueError, YAMLError):
            return []
        providers = config.get("providers") or {}
        # Direct per-task credential overrides cannot be distinguished by the current observation payload.
        def overrides(value):
            if isinstance(value, dict):
                return any((key in {"api_key", "apiKey", "key_cmd"} and bool(item)) or overrides(item)
                           for key, item in value.items())
            return isinstance(value, list) and any(overrides(item) for item in value)
        if any(overrides(config.get(key)) for key in ("model", "auxiliary", "fallback_model", "fallback_models", "delegation")):
            return []
        accepted = []
        for model in snapshots:
            expected = model.get("runtimeProvider", "").removeprefix("custom:")
            matches = [(key, entry) for key, entry in providers.items() if isinstance(entry, dict)
                       and str(entry.get("api") or entry.get("base_url") or "").rstrip("/") == model.get("baseUrl")]
            if (len(matches) == 1 and matches[0][0] == expected
                    and matches[0][1].get("key_env") == "DESKTOP_MT_MAAS_API_KEY"
                    and not overrides(matches[0][1])):
                accepted.append({**model, "runtimeProvider": "custom"})
        return accepted

    def skill(self, name, directory, provenance):
        # Installed kit paths retain the original component name even when the display name is shortened.
        if directory:
            try:
                relative = Path(directory).resolve().relative_to((self.home / "skills" / "kits").resolve())
                owner, *parts = relative.parts
                entry = self.plugins().get(owner, {})
                if name in entry.get("skill_names", []) and parts:
                    component = "/".join(parts[1:] if parts[0] == "skills" else parts)
                    subject = resource(f"plugin:{owner}/{component}", name)
                    if subject:
                        return {**subject, "type": "skill"}, resource(owner, entry.get("display_name"))
            except (OSError, ValueError):
                pass
        installed = read_json(self.home / "skills" / ".hub" / "lock.json").get("installed", {}).get(name, {})
        if installed.get("source") == "uniwork" and text(installed.get("identifier"), 249):
            # The UniWork market adapter writes source=uniwork and the server resource ID.
            subject = resource("market:" + installed["identifier"], name)
            return {**subject, "type": "skill"}, None
        if directory and provenance == "installed":
            try:
                relative = Path(directory).resolve().relative_to((self.home / "skills").resolve())
                bundled = (self.home / "skills" / ".bundled_manifest").read_text(encoding="utf-8")
                if name in {line.split(":", 1)[0] for line in bundled.splitlines() if line and not line.startswith("#")}:
                    subject = resource("builtin:" + relative.name, name)
                    return ({**subject, "type": "skill"} if subject else None), None
            except (OSError, ValueError):
                pass
        return None, None

    def mcp(self, tool_name):
        try:
            config = read_config(self.home)
        except (OSError, ValueError, YAMLError):
            return None, None
        servers = config.get("mcp_servers") or {}
        # Hashed/truncated runtime names cannot recover the actual leaf tool through observer hooks.
        if len(tool_name) == 64 and re.search(r"_[0-9a-f]{8}$", tool_name):
            return None, None
        matches = []
        for server, definition in servers.items():
            safe = re.sub(r"[^a-zA-Z0-9_]", "_", server)
            prefix = f"mcp__{safe}__"
            if tool_name.startswith(prefix) and isinstance(definition, dict):
                matches.append((server, definition, tool_name[len(prefix):]))
        if len(matches) != 1:
            return None, None
        server, definition, tool = matches[0]
        if not text(tool, 128):
            return None, None
        subject = plugin = None
        connector = definition.get("desktop_connector")
        if connector in CONNECTORS and server == "connector_" + connector:
            subject = resource("connector:" + connector)
        elif server == "connector_wo_mail" and definition.get("desktop_agent_mail") is True:
            subject = resource("connector:wo_mail", "智能体邮箱")
        elif server == "UniWork-Drive" and definition.get("uniwork_managed") == "uniwork.desktop.drive.v1":
            subject = resource("connector:netdrive", "云盘")
        elif text(definition.get("uniwork_builtin_id"), 248):
            # The desktop installer carries the original business ID; names/URLs are not IDs.
            subject = resource("builtin:" + definition["uniwork_builtin_id"], server)
        elif (shared := SHARED.get(str(definition.get("url", "")).rstrip("/"))):
            subject = resource("shared:" + shared)
        else:
            owners = [(name, entry) for name, entry in self.plugins().items()
                      if isinstance(entry, dict) and server in entry.get("mcp_keys", [])]
            if len(owners) == 1:
                owner, entry = owners[0]
                prefix = "plugin_" + owner + "_"
                # Duplicate unknown endpoints across kits have no known global business ID.
                url = definition.get("url")
                shared_count = sum(isinstance(d, dict) and bool(url) and d.get("url") == url for d in servers.values())
                if server.startswith(prefix) and shared_count <= 1:
                    component = server[len(prefix):]
                    subject = resource(f"plugin:{owner}/{component}", component)
                    plugin = resource(owner, entry.get("display_name"))
        return ({**subject, "type": "mcp", "tool": tool} if subject else None), plugin
