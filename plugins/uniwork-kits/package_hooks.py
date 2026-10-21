"""Run a package's own command hooks on Hermes lifecycle events.

Install stores the ``hooks`` object instead of discarding it. Commands are the
ones the package author wrote, run the way Claude Code / WorkBuddy run them:
the event arrives as JSON on stdin, and a ``PreToolUse`` hook blocks the tool
only by exiting with 2 or by answering ``{"decision": "block"}`` /
``permissionDecision: "deny"``. Any other failure — a missing interpreter on
Windows, a crash, a timeout — is the hook's problem, not a reason to stop
every matching tool. stdin is never inherited: the TUI backend speaks JSON-RPC
over it.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import store

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
    "read_file": "Read",
    "terminal": "Bash",
    "web_search": "WebSearch",
    "web_extract": "WebFetch",
}
BLOCK_EXIT = 2


def load_declared(root: Path, raw: Dict[str, Any]) -> Dict[str, Any]:
    """读出包里声明的钩子：plugin.json 里直接写的，或它指向的 JSON 文件里的。"""
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
    """把一组钩子声明展开成命令列表（匹配规则、命令、超时），两种写法都认。"""
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
    """钩子的匹配规则是否命中这个工具名（也用 WorkBuddy 里的同名工具名去比）；规则写错时不命中。"""
    if not matcher:
        return True
    alias = _TOOL_ALIAS.get(tool_name, "")
    try:
        pattern = re.compile(matcher)
    except re.error:
        return False
    return bool(pattern.search(tool_name) or (alias and pattern.search(alias)))


def _installed(home: Path) -> List[tuple]:
    """已启用、并且声明了钩子的包：（包目录, 钩子）列表。"""
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


def _payload(event: str, tool_name: str, args: Any, session_id: str) -> bytes:
    """按 WorkBuddy 的格式拼出传给钩子命令的 JSON 输入。"""
    data: Dict[str, Any] = {
        "hook_event_name": _EVENT.get(event, event),
        "session_id": session_id,
        "cwd": os.getcwd(),
    }
    if event in {"pre_tool_call", "post_tool_call"}:
        data["tool_name"] = _TOOL_ALIAS.get(tool_name, tool_name)
        data["tool_input"] = args if isinstance(args, dict) else {}
    return json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")


def run_matching(
    home: Path, event: str, tool_name: str = "", args: Any = None, session_id: str = "",
) -> List[subprocess.CompletedProcess]:
    """运行所有命中的命令钩子，返回每个命令的结果；退出码代表什么由调用方决定。

    每个命令最多跑 30 秒，超时或启动失败记成退出码 124。
    """
    package_event = _EVENT.get(event)
    if not package_event:
        return []
    results = []
    stdin = _payload(event, tool_name, args, session_id)
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
                        input=stdin,
                        capture_output=True,
                        timeout=timeout,
                        env={**os.environ, "CODEBUDDY_PLUGIN_ROOT": root.as_posix(), "CLAUDE_PLUGIN_ROOT": root.as_posix()},
                    )
                )
            except (subprocess.TimeoutExpired, OSError) as exc:
                results.append(subprocess.CompletedProcess(command, 124, b"", str(exc).encode("utf-8")))
    return results


def _denial(result: subprocess.CompletedProcess) -> Optional[str]:
    """钩子要求拦下这次调用时返回拦截原因，否则返回 None（支持退出码和 JSON 两种表达）。"""
    stderr = (result.stderr or b"").decode("utf-8", "replace").strip()
    stdout = (result.stdout or b"").decode("utf-8", "replace").strip()
    if result.returncode == BLOCK_EXIT:
        return stderr or stdout or "套件钩子拦下了这次调用"
    if result.returncode != 0 or not stdout.startswith("{"):
        return None
    try:
        answer = json.loads(stdout)
    except ValueError:
        return None
    if not isinstance(answer, dict):
        return None
    specific = answer.get("hookSpecificOutput") if isinstance(answer.get("hookSpecificOutput"), dict) else {}
    if answer.get("decision") == "block" or specific.get("permissionDecision") == "deny":
        return str(answer.get("reason") or specific.get("permissionDecisionReason") or "套件钩子拦下了这次调用")
    return None


def on_pre_tool_call(tool_name: str = "", args: Any = None, session_id: str = "", **_: Any) -> Optional[Dict[str, str]]:
    """工具调用前跑包里的钩子，有钩子要求拦截就拦下并说明原因。"""
    from hermes_constants import get_hermes_home

    home = Path(get_hermes_home())
    for result in run_matching(home, "pre_tool_call", tool_name, args, session_id):
        message = _denial(result)
        if message:
            return {"action": "block", "message": message}
    return None


def on_observed(event: str, tool_name: str = "", **kwargs: Any) -> None:
    """把其他事件（调用后、会话开始结束）转给包里的钩子，只运行不拦截。"""
    from hermes_constants import get_hermes_home

    run_matching(Path(get_hermes_home()), event, tool_name, kwargs.get("args"), str(kwargs.get("session_id") or ""))
