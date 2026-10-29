"""企业对接插件测试共用的：把插件目录加进 sys.path（目录里带着 dist-info，hermes 按 entry point 认得出它，
和镜像里装好以后一样），以及写实例主目录里 plugin.json、.env 的小工具。"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt" / "plugin"
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))
    importlib.invalidate_caches()

SERVER = "http://platform.test:11220"
TOKEN_ENV = "HERMES_CUSTOM_YUANJING_API_KEY"


def write_settings(root: Path, **overrides) -> None:
    payload = {"v": 1, "enabled": True, "server": SERVER, "tokenEnv": TOKEN_ENV, "toolAudit": True, **overrides}
    path = root / ".cache" / "uniwork-enterprise" / "plugin.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def write_token(root: Path, token: str) -> None:
    (root / ".env").write_text(f"TERMINAL_ENV=local\n{TOKEN_ENV}={token}\n", encoding="utf-8")
