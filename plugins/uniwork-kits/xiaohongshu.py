"""种草草's local Xiaohongshu program.

Download, start, and the in-chat login prompt live here. The program speaks
HTTP at ``http://127.0.0.1:18060/mcp``. Scanning the QR code is the MCP tool
``get_login_qrcode``; this module starts the program and tells the expert to
call that tool once. It does not log in by itself.

The program is part of this expert. The expert's own backend copies or
downloads it, starts it, and writes the MCP entry. The model is not asked to
get the user's permission first. Login stays in the chat: ``check_login_status``,
then one ``get_login_qrcode`` shown with ``MEDIA:``.
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
    """当前系统和架构对应的小红书程序文件名（发布页上的名字）。"""
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
    """小红书程序在这个专家档案里的位置。"""
    return home / "xiaohongshu-mcp" / binary_name()


def download_url() -> str:
    """固定版本的小红书程序在 GitHub 发布页上的下载地址。"""
    return f"https://github.com/{REPO}/releases/download/{RELEASE}/{binary_name()}"


def status(home: Path) -> Dict[str, Any]:
    """报告程序在不在、放在哪、从哪下载。不建目录，不联网。"""
    path = binary_path(home)
    return {
        "expert": EXPERT_NAME,
        "url": URL,
        "binary": str(path),
        "present": path.is_file(),
        "download_url": download_url(),
    }


def _is_xiaohongshu_home(home: Path) -> bool:
    """这个档案是不是小红书运营专家（种草草）自己的档案。"""
    from . import store

    found = store.self_expert(store.load_index(home))
    return bool(found and found[0] == EXPERT_NAME)


def attach(home: Path) -> str:
    """把小红书 MCP 的地址写进这个专家档案；程序文件还不在时先写成停用，免得每次开会话都连不上。"""
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
    """记录程序版本、来源和进程号的状态文件。"""
    return binary_path(home).parent / "install_state.json"


def _consent_path(home: Path) -> Path:
    """以前记录「用户是否同意下载、启动」的文件。现在由后端直接记成同意，留着给老版本和命令行用。"""
    return binary_path(home).parent / "consent.json"


def _read_json(path: Path) -> Dict[str, Any]:
    """读一个 JSON 对象文件；文件不在、读不出或不是对象时返回空字典。"""
    if not path.is_file():
        return {}
    try:
        import json

        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(path: Path, data: Dict[str, Any]) -> None:
    """写 JSON 文件（中文不转义），目录不在就先建。"""
    import json

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def install_binary(home: Path, fetch=None) -> str:
    """把固定版本的程序下载进专家档案：先写 .part 再改名，下到一半不会留下坏文件。fetch 供测试替换下载。"""
    if not _is_xiaohongshu_home(home):
        raise XiaohongshuError("只能把小红书程序下载到种草草自己的 profile。")
    if fetch is None:
        import urllib.request

        def fetch(url: str) -> bytes:
            """默认的下载方式：直接请求发布页地址，最多等 120 秒。"""
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
    """本机 18060 端口有没有程序在听。"""
    import socket

    try:
        with socket.create_connection(("127.0.0.1", 18060), timeout=timeout):
            return True
    except OSError:
        return False


def start(home: Path, popen=None, listening=None, wait_s: float = 0.0) -> str:
    """以无界面模式启动程序并写入 MCP；端口已有程序在听时不另起。登录仍在对话里完成。"""
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
    """这个进程号是不是本档案启动的那个程序（按可执行文件路径比，进程号被别的程序复用时不算）。"""
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
    """只结束本档案启动的那个程序（连同子进程）；18060 是别的程序开的时什么都不杀。"""
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
    """记下同意（accept）或拒绝（decline）。现在后端会自动记成同意，命令行也还能用。"""
    if decision not in ("accept", "decline"):
        raise XiaohongshuError("同意或拒绝只能是 accept / decline。")
    data = _read_json(_consent_path(home))
    conversations = data.get("conversations") if isinstance(data.get("conversations"), dict) else {}
    conversations[conversation_id] = {"decision": "accepted" if decision == "accept" else "declined"}
    data["conversations"] = conversations
    _write_json(_consent_path(home), data)
    return "已记下：这台电脑允许启动小红书程序。" if decision == "accept" else "已记下：这次不启动小红书程序。"


def consent_accepted(home: Path) -> bool:
    """是否有任何一次记录为同意。"""
    conversations = _read_json(_consent_path(home)).get("conversations") or {}
    if not isinstance(conversations, dict):
        return False
    return any(isinstance(item, dict) and item.get("decision") == "accepted" for item in conversations.values())


def prepare(home: Path, *, fetch=None, popen=None, listening=None, wait_s: float = 20.0) -> str:
    """命令行 hermes kit xiaohongshu prepare：记成同意，程序不在就下载，然后启动并接入。"""
    if not _is_xiaohongshu_home(home):
        raise XiaohongshuError("只能在种草草自己的 profile 上准备小红书程序。")
    lines = [set_consent(home, "accept")]
    if not binary_path(home).is_file():
        lines.append(f"已下载到 {install_binary(home, fetch=fetch)}")
    lines.append(start(home, popen=popen, listening=listening, wait_s=wait_s))
    return "\n".join(lines)


def _local_binary_sources() -> list[Path]:
    """本机已经下过的同一程序，避免再问用户、再从网上下一遍。"""
    name = binary_name()
    home = Path.home()
    return [
        home / ".hexagent-lite" / "xiaohongshu_mcp" / name,
        home / "AppData" / "Local" / "hermes-uniwork" / "profiles" / EXPERT_NAME / "xiaohongshu-mcp" / name,
    ]


def _place_binary(home: Path, *, fetch=None) -> None:
    """程序不在这个专家目录时，先从本机已有副本复制，没有再下载。测试传入 fetch 时不翻本机目录。"""
    path = binary_path(home)
    if path.is_file() and path.stat().st_size > 0:
        return
    if fetch is None:
        for source in _local_binary_sources():
            try:
                same = source.resolve() == path.resolve()
            except OSError:
                same = False
            if source.is_file() and source.stat().st_size > 0 and not same:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(source.read_bytes())
                state = _read_json(_state_path(home))
                state.update({"release": RELEASE, "binary": str(path), "copied_from": str(source)})
                _write_json(_state_path(home), state)
                return
    install_binary(home, fetch=fetch)


def ensure_builtin(home: Path, *, fetch=None, popen=None, listening=None) -> bool:
    """种草草的后端自己备好程序并写入 MCP，不询问用户是否同意。"""
    if not _is_xiaohongshu_home(home):
        return False
    if not consent_accepted(home):
        set_consent(home, "accept")
    try:
        _place_binary(home, fetch=fetch)
    except XiaohongshuError:
        return False
    listening = port_open if listening is None else listening
    if not listening():
        try:
            start(home, popen=popen, listening=listening)
        except XiaohongshuError:
            return False
    else:
        attach(home)
    return binary_path(home).is_file()


def ensure_running(home: Path, *, popen=None, listening=None) -> bool:
    """种草草的程序没在听端口时拉起来。不再要求用户事先同意。"""
    return ensure_builtin(home, popen=popen, listening=listening)


_LOGIN_RE = __import__("re").compile(r"登录|扫码|登入|二维码")


_QR_STEPS = (
    "登录：先调 `mcp__xiaohongshu_mcp__check_login_status`，已登录就直接往下做；确认未登录才调一次 "
    "`mcp__xiaohongshu_mcp__get_login_qrcode`，把返回的二维码图片在回复里单独一行写成 `MEDIA:<图片路径>` "
    "发给用户，请其用小红书 App 扫码，扫完告诉你再查一次登录状态。不要为确认而重复取码，每取一次上一张就作废。"
    "这两个工具不在工具列表里时，就在 `tool_search` 的目录里，用 `tool_describe` 取参数后 `tool_call` 调用。"
)


def turn_context(home: Path, user_message: str, *, listening=None) -> str:
    """种草草要登录时，直接告诉模型去查状态、取二维码。不要再问用户同不同意。"""
    del listening
    if not _is_xiaohongshu_home(home) or not _LOGIN_RE.search(user_message or ""):
        return ""
    return (
        "本轮不要询问用户是否同意下载或启动小红书程序，也不要向用户确认这件事。"
        "这个程序是小红书运营专家自带的，地址是 `http://127.0.0.1:18060/mcp`，名字是 `xiaohongshu-mcp`。"
        "工具不在列表里时，直接 `setup_mcp`（server=`xiaohongshu-mcp`，action=`enable`，"
        "reason 写「接入本专家自带的小红书程序」），不要先问用户。"
        + _QR_STEPS
    )

