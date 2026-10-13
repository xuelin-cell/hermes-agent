"""Run a package's own command hooks on Hermes lifecycle events.

Install stores the ``hooks`` object instead of discarding it. Commands are the
ones the package author wrote. ``PreToolUse`` can block a tool when the command
exits non-zero. A timeout on that event also blocks.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import deck_check, store

_EVENT = {
    "pre_tool_call": "PreToolUse",
    "post_tool_call": "PostToolUse",
    "on_session_start": "SessionStart",
    "on_session_end": "Stop",
}
_TOOL_ALIAS = {
    "skill_view": "Skill",
    "write_file": "Write",
    "patch": "Edit",
}


def load_declared(root: Path, raw: Dict[str, Any]) -> Dict[str, Any]:
    """The hooks object from plugin.json, or from the JSON file it points at."""
    hooks = raw.get("hooks")
    if isinstance(hooks, str) and hooks.strip():
        path = root / hooks
        if not path.is_file():
            return {}
        try:
            import json

            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        hooks = data.get("hooks") if isinstance(data, dict) else None
    return hooks if isinstance(hooks, dict) else {}


def _commands(group: Any) -> List[Dict[str, Any]]:
    if not isinstance(group, list):
        return []
    found: List[Dict[str, Any]] = []
    for item in group:
        if not isinstance(item, dict):
            continue
        matcher = str(item.get("matcher") or "")
        inner = item.get("hooks")
        if isinstance(inner, list):
            for hook in inner:
                if isinstance(hook, dict) and hook.get("command"):
                    found.append({"matcher": matcher, "command": str(hook["command"]), "timeout": hook.get("timeout") or 10})
        elif item.get("command"):
            found.append({"matcher": matcher, "command": str(item["command"]), "timeout": item.get("timeout") or 10})
    return found


def _matches(matcher: str, tool_name: str) -> bool:
    if not matcher:
        return True
    alias = _TOOL_ALIAS.get(tool_name, "")
    try:
        pattern = re.compile(matcher)
    except re.error:
        return False
    return bool(pattern.search(tool_name) or (alias and pattern.search(alias)))


def _installed(home: Path) -> List[tuple]:
    index = store.load_index(home)
    rows = []
    for name, entry in (index.get("plugins") or {}).items():
        if not isinstance(entry, dict) or not entry.get("enabled", True):
            continue
        hooks = entry.get("hooks")
        source = entry.get("source_dir")
        if isinstance(hooks, dict) and isinstance(source, str) and source:
            rows.append((home / source, hooks))
    return rows


def run_matching(home: Path, event: str, tool_name: str = "") -> List[subprocess.CompletedProcess]:
    """Run matching command hooks. The caller decides what a non-zero exit means."""
    package_event = _EVENT.get(event)
    if not package_event:
        return []
    results = []
    for root, hooks in _installed(home):
        for hook in _commands(hooks.get(package_event)):
            if event in {"pre_tool_call", "post_tool_call"} and not _matches(hook["matcher"], tool_name):
                continue
            command = (
                hook["command"]
                .replace("${CODEBUDDY_PLUGIN_ROOT}", root.as_posix())
                .replace("${CLAUDE_PLUGIN_ROOT}", root.as_posix())
                .replace("${CODEBUDDY_PROJECT_DIR}", Path.cwd().as_posix())
            )
            timeout = min(int(hook["timeout"] or 10), 30)
            try:
                results.append(
                    subprocess.run(
                        command,
                        shell=True,
                        cwd=str(root),
                        capture_output=True,
                        timeout=timeout,
                        env={**os.environ, "CODEBUDDY_PLUGIN_ROOT": root.as_posix()},
                    )
                )
            except subprocess.TimeoutExpired as exc:
                failed = subprocess.CompletedProcess(command, 124, b"", str(exc).encode("utf-8"))
                results.append(failed)
                if event == "pre_tool_call":
                    return results
    return results


def on_pre_tool_call(tool_name: str = "", args: Any = None, **_: Any) -> Optional[Dict[str, str]]:
    from hermes_constants import get_hermes_home

    home = Path(get_hermes_home())
    for result in run_matching(home, "pre_tool_call", tool_name):
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or b"").decode("utf-8", "replace").strip()
            return {"action": "block", "message": detail or f"套件钩子退出 {result.returncode}"}
    return None


def on_observed(event: str, tool_name: str = "", **_: Any) -> None:
    from hermes_constants import get_hermes_home

    run_matching(Path(get_hermes_home()), event, tool_name)


def on_transform_tool_result(tool_name: str = "", args: Any = None, result: str = "", **_: Any) -> Optional[str]:
    return deck_check.annotate(tool_name, args, result if isinstance(result, str) else str(result or ""))
