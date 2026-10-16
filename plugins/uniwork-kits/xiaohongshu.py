"""种草草's local Xiaohongshu program.

Download, start, and the in-chat login prompt live here. The program speaks
HTTP at ``http://127.0.0.1:18060/mcp``. Scanning the QR code is the MCP tool
``get_login_qrcode``; this module starts the program and tells the expert to
call that tool once. It does not log in by itself.

数字员工 asked in the chat, then downloaded, started and showed the QR code
itself. Here the same steps run through tools the expert already has: it asks
with ``clarify``, runs ``hermes kit xiaohongshu prepare`` (consent, download,
start, connect), calls ``setup_mcp`` so the desktop reloads the server into the
open chat, and sends the QR image back with ``MEDIA:``. After a reboot the
program starts again on its own once consent is on record
(:func:`ensure_running`).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict

EXPERT_NAME = "xiaohongshu-operations-expert"
MCP_KEY = "xiaohongshu-mcp"
URL = "http://127.0.0.1:18060/mcp"
RELEASE = "v2.5.5"
REPO = "xpzouying/xiaohongshu-mcp"


class XiaohongshuError(Exception):
    """The profile is not 种草草's, or Hermes refused the MCP entry."""


def binary_name() -> str:
    if sys.platform == "win32":
        return "xiaohongshu-mcp-windows-amd64.exe"
    if sys.platform == "darwin":
        import platform

        machine = platform.machine().lower()
        if machine in {"arm64", "aarch64"}:
            return "xiaohongshu-mcp-darwin-arm64"
        return "xiaohongshu-mcp-darwin-amd64"
    return "xiaohongshu-mcp-linux-amd64"


def binary_path(home: Path) -> Path:
    return home / "xiaohongshu-mcp" / binary_name()


def download_url() -> str:
    return f"https://github.com/{REPO}/releases/download/{RELEASE}/{binary_name()}"


def status(home: Path) -> Dict[str, Any]:
    """Report the slot. Does not create directories or contact the network."""
    path = binary_path(home)
    return {
        "expert": EXPERT_NAME,
        "url": URL,
        "binary": str(path),
        "present": path.is_file(),
        "download_url": download_url(),
    }


def _is_xiaohongshu_home(home: Path) -> bool:
    from . import store

    found = store.self_expert(store.load_index(home))
    return bool(found and found[0] == EXPERT_NAME)


def attach(home: Path) -> str:
    """Write the HTTP MCP entry into *home*. Enable it only when the binary is there."""
    from . import store

    if not _is_xiaohongshu_home(home):
        raise XiaohongshuError(
            "小红书 MCP 只写入种草草自己的 profile（xiaohongshu-operations-expert）。"
            "先装好这个专家，再在它的 profile 上执行 attach。"
        )
    present = binary_path(home).is_file()
    cfg = {"url": URL, "enabled": present}
    with store.scoped_home(home):
        from hermes_cli.mcp_config import _get_mcp_servers, _save_mcp_server

        current = _get_mcp_servers().get(MCP_KEY)
        if isinstance(current, dict) and current.get("url") == URL and bool(current.get("enabled", True)) == present:
            return "已经接上，没有改配置。"
        if not _save_mcp_server(MCP_KEY, cfg):
            raise XiaohongshuError("Hermes 拒绝写入这台 MCP。")
    if present:
        return f"已把 `{MCP_KEY}` 写进这个 profile，地址 {URL}。新会话才会连上。"
    return f"已写入但先停用：程序还不在 {binary_path(home)}。放好文件后再执行一次 attach。"


def _state_path(home: Path) -> Path:
    return binary_path(home).parent / "install_state.json"


def _consent_path(home: Path) -> Path:
    return binary_path(home).parent / "consent.json"


def _read_json(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        import json

        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(path: Path, data: Dict[str, Any]) -> None:
    import json

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def install_binary(home: Path, fetch=None) -> str:
    """Download the pinned release into the expert profile. *fetch* is for tests."""
    if not _is_xiaohongshu_home(home):
        raise XiaohongshuError("只能把小红书程序下载到种草草自己的 profile。")
    if fetch is None:
        import urllib.request

        def fetch(url: str) -> bytes:
            with urllib.request.urlopen(url, timeout=120) as response:
                return response.read()

    data = fetch(download_url())
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise XiaohongshuError("下载到的小红书程序是空的。")
    path = binary_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    part.write_bytes(bytes(data))
    part.replace(path)
    state = _read_json(_state_path(home))
    state.update({"release": RELEASE, "binary": str(path)})
    _write_json(_state_path(home), state)
    return str(path)


def port_open(timeout: float = 0.4) -> bool:
    import socket

    try:
        with socket.create_connection(("127.0.0.1", 18060), timeout=timeout):
            return True
    except OSError:
        return False


def start(home: Path, popen=None, listening=None, wait_s: float = 0.0) -> str:
    """Start the binary with ``-headless=true``. Login stays in the chat."""
    if not binary_path(home).is_file():
        raise XiaohongshuError(f"还没有程序：{binary_path(home)}。先执行 hermes kit xiaohongshu install。")
    listening = port_open if listening is None else listening
    if listening():
        attach(home)
        return f"18060 已经在服务。登录请在种草草的对话里说「扫码登录」，它会调用 `mcp__xiaohongshu_mcp__get_login_qrcode`。"
    import subprocess

    popen = subprocess.Popen if popen is None else popen
    exe = binary_path(home)
    if sys.platform != "win32":
        exe.chmod(exe.stat().st_mode | 0o111)
    log_dir = exe.parent
    flags = {}
    if sys.platform == "win32":
        flags["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    # The child keeps its own copies of the handles; ours close right away.
    with (log_dir / "mcp-stdout.log").open("ab") as stdout, (log_dir / "mcp-stderr.log").open("ab") as stderr:
        proc = popen([str(exe), "-headless=true"], cwd=str(log_dir), stdout=stdout, stderr=stderr, **flags)
    state = _read_json(_state_path(home))
    state.update({"pid": getattr(proc, "pid", 0), "running": True})
    _write_json(_state_path(home), state)
    if wait_s and not listening():
        import time

        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline and not listening():
            time.sleep(0.05)
    attach(home)
    if listening():
        return "已启动。在种草草的对话里说「扫码登录」。"
    return "已启动，18060 还没就绪。首次启动可能在下载浏览器；稍后再说「扫码登录」。"


def _ours(pid: int, home: Path) -> bool:
    """Whether *pid* is still the program this profile started (a recycled pid is not)."""
    try:
        import psutil

        exe = psutil.Process(pid).exe()
    except Exception:
        return False
    try:
        return Path(exe).resolve() == binary_path(home).resolve()
    except OSError:
        return False


def stop(home: Path) -> str:
    state = _read_json(_state_path(home))
    pid = int(state.get("pid") or 0)
    stopped = False
    if pid and _ours(pid, home):
        import psutil

        try:
            process = psutil.Process(pid)
            for child in process.children(recursive=True):
                child.kill()
            process.kill()
            stopped = True
        except psutil.Error:
            pass
    state["pid"] = 0
    state["running"] = False
    _write_json(_state_path(home), state)
    if stopped:
        return "已停止本机小红书程序。"
    return "没有找到这个 profile 启动的小红书程序（可能已经退出，或 18060 是别的程序开的），没有结束任何进程。"


def set_consent(home: Path, decision: str, conversation_id: str = "machine") -> str:
    if decision not in ("accept", "decline"):
        raise XiaohongshuError("同意或拒绝只能是 accept / decline。")
    data = _read_json(_consent_path(home))
    conversations = data.get("conversations") if isinstance(data.get("conversations"), dict) else {}
    conversations[conversation_id] = {"decision": "accepted" if decision == "accept" else "declined"}
    data["conversations"] = conversations
    _write_json(_consent_path(home), data)
    return "已记下：这台电脑允许启动小红书程序。" if decision == "accept" else "已记下：这次不启动小红书程序。"


def consent_accepted(home: Path) -> bool:
    conversations = _read_json(_consent_path(home)).get("conversations") or {}
    if not isinstance(conversations, dict):
        return False
    return any(isinstance(item, dict) and item.get("decision") == "accepted" for item in conversations.values())


def prepare(home: Path, *, fetch=None, popen=None, listening=None, wait_s: float = 20.0) -> str:
    """The user agreed in the chat: record it, download if missing, start, connect."""
    if not _is_xiaohongshu_home(home):
        raise XiaohongshuError("只能在种草草自己的 profile 上准备小红书程序。")
    lines = [set_consent(home, "accept")]
    if not binary_path(home).is_file():
        lines.append(f"已下载到 {install_binary(home, fetch=fetch)}")
    lines.append(start(home, popen=popen, listening=listening, wait_s=wait_s))
    return "\n".join(lines)


def ensure_running(home: Path, *, popen=None, listening=None) -> bool:
    """Start the program for 种草草 when consent is on record and it is not serving yet."""
    if not _is_xiaohongshu_home(home) or not consent_accepted(home) or not binary_path(home).is_file():
        return False
    listening = port_open if listening is None else listening
    if listening():
        return False
    start(home, popen=popen, listening=listening)
    return True


_LOGIN_RE = __import__("re").compile(r"登录|扫码|登入|二维码")


_QR_STEPS = (
    "登录：先调 `mcp__xiaohongshu_mcp__check_login_status`，已登录就直接往下做；确认未登录才调一次 "
    "`mcp__xiaohongshu_mcp__get_login_qrcode`，把返回的二维码图片在回复里单独一行写成 `MEDIA:<图片路径>` "
    "发给用户，请其用小红书 App 扫码，扫完告诉你再查一次登录状态。不要为确认而重复取码，每取一次上一张就作废。"
    "这两个工具不在工具列表里时，就在 `tool_search` 的目录里，用 `tool_describe` 取参数后 `tool_call` 调用。"
)


def turn_context(home: Path, user_message: str, *, listening=None) -> str:
    """Prompt for 种草草 only. Empty when this turn does not touch the account."""
    if not _is_xiaohongshu_home(home) or not _LOGIN_RE.search(user_message or ""):
        return ""
    profile = home.name
    connect = (
        f"在终端运行 `hermes -p {profile} kit xiaohongshu prepare`（记下同意、下载并在本机启动程序，第一次可能要等一会儿），"
        "成功后调用 `setup_mcp`（server=`xiaohongshu-mcp`，action=`enable`，reason 写「接入本机小红书程序，用来扫码登录」），"
        "用户在卡片上点接入后工具就在本次对话里可用。"
    )
    if not consent_accepted(home):
        return (
            "用户要登录小红书，这台电脑还没同意启动本机程序。先用 `clarify` 问一次是否允许，说明："
            "会从 GitHub 下载开源的非官方小红书程序 xiaohongshu-mcp，在本机后台运行，用来扫码登录、搜索和发布。"
            "用户同意后：" + connect + "然后" + _QR_STEPS
            + "用户不同意就不再提，继续做不依赖账号的工作（定位、选题、文案、封面）。"
        )
    listening = port_open if listening is None else listening
    if not binary_path(home).is_file() or not listening():
        return "用户要登录小红书，本机程序还没就绪（用户之前已同意）。" + connect + "然后" + _QR_STEPS
    return _QR_STEPS

