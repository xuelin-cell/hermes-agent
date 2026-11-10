"""数字员工 Codex 的一次性 CLI 适配；生命周期和展示由原生 terminal 工具负责。"""

from __future__ import annotations

import json
from pathlib import Path
import signal
import tempfile
import threading
import time

# 暂停产品入口，保留实现供后续恢复；不提供用户配置绕过。
ENABLED = False
DISABLED_MESSAGE = "/codex 暂未开放，请直接描述开发任务。"


def emit(kind, **values):
    """输出结构化事件，不传递原始异常或模型凭据。"""
    print(json.dumps({"type": kind, **values}, ensure_ascii=False), flush=True)


def runtime_binary(pause_event=None):
    """通过原生包管理器准备锁定的运行组件，不依赖宿主 PATH。"""
    from pm import ensure, installed_package

    ensure("codex", pause_event=pause_event)
    installed = installed_package("codex")
    if installed is None or installed.binary is None:
        raise FileNotFoundError("codex")
    return str(installed.binary)


def execute(config):
    """用独立配置目录运行一次任务，并负责停止及资源回收。"""
    from agent.transports.codex_chat_proxy import CodexChatProxy

    stopped = False
    pause_event = threading.Event()

    def stop(*_):
        """响应原生终端工具的停止信号。"""
        nonlocal stopped
        stopped = True
        pause_event.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    proxy = None
    phase = "runtime"
    client = None
    thread_id = turn_id = None
    temporary_home = tempfile.TemporaryDirectory(prefix="uniwork-codex-")
    try:
        binary = runtime_binary(pause_event)
        if stopped:
            emit("result", status="cancelled", text="")
            return 130
        phase = "execution"
        proxy = CodexChatProxy(
            model=config["model"],
            base_url=config["base_url"],
            api_key=config["api_key"],
        )
        # An empty, per-invocation Codex home excludes personal plugins/auth/MCP.
        home = temporary_home.name
        client = proxy.client_factory(codex_bin=binary, codex_home=home)
        client.initialize(
            client_name="uniwork-code", client_title="UniWork Code", client_version="1"
        )
        if stopped:
            emit("result", status="cancelled", text="")
            return 130
        thread = client.request(
            "thread/start",
            {
                "cwd": config["cwd"],
                "model": config["model"],
                "modelProvider": "hermes_code",
                "approvalPolicy": "on-request",
                "sandbox": "workspace-write",
                "personality": "none",
            },
        )
        thread_id = thread["thread"]["id"]
        turn = client.request(
            "turn/start",
            {
                "threadId": thread_id,
                "input": [{"type": "text", "text": config["prompt"]}],
                "model": config["model"],
                "approvalPolicy": "on-request",
                "sandboxPolicy": {
                    "type": "workspaceWrite",
                    "writableRoots": [config["cwd"]],
                    "networkAccess": False,
                },
            },
        )
        turn_id = turn["turn"]["id"]
        deadline = time.monotonic() + 600
        final_text = ""
        while not stopped and time.monotonic() < deadline:
            if not client.is_alive():
                raise RuntimeError("executor_exited")
            request = client.take_server_request(timeout=0)
            if request is not None:
                # Never turn a non-interactive approval into consent or wait forever.
                method = request.get("method", "")
                if method in (
                    "item/commandExecution/requestApproval",
                    "item/fileChange/requestApproval",
                    "item/permissions/requestApproval",
                ):
                    client.respond(request["id"], {"decision": "decline"})
                elif method == "mcpServer/elicitation/request":
                    client.respond(request["id"], {"action": "decline"})
                else:
                    client.respond_error(
                        request["id"], -32601, "Interactive request unavailable"
                    )
                emit("result", status="approval_required", text="")
                return 3
            note = client.take_notification(timeout=0.2)
            if note is None:
                continue
            params = note.get("params") or {}
            if params.get("threadId") not in (None, thread_id) or params.get(
                "turnId"
            ) not in (None, turn_id):
                continue
            method = note.get("method")
            if method == "item/agentMessage/delta":
                emit("delta", text=str(params.get("delta") or ""))
            elif method == "item/completed":
                item = params.get("item") or {}
                if item.get("type") == "agentMessage":
                    final_text = str(item.get("text") or "")
            elif method == "turn/completed":
                completed = params.get("turn") or {}
                if completed.get("id") != turn_id:
                    continue
                status = (
                    "completed" if completed.get("status") == "completed" else "failed"
                )
                emit("result", status=status, text=final_text)
                return 0 if status == "completed" else 1
        emit("result", status="cancelled" if stopped else "failed", text="")
        return 130 if stopped else 1
    except FileNotFoundError:
        emit("result", status="failed", text="", reason="runtime_unavailable")
        return 1
    except Exception:
        # Upstream exceptions may contain credentials, endpoint query strings or model input.
        if stopped:
            emit("result", status="cancelled", text="")
            return 130
        emit(
            "result",
            status="failed",
            text="Codex 运行组件准备失败，请检查应用安装和下载网络。"
            if phase == "runtime"
            else "",
            reason="runtime_prepare_failed"
            if phase == "runtime"
            else "execution_failed",
        )
        return 1
    finally:
        if client is not None:
            if thread_id and turn_id:
                try:
                    client.request(
                        "turn/interrupt",
                        {"threadId": thread_id, "turnId": turn_id},
                        timeout=2,
                    )
                except Exception:
                    pass
            client.close()
        if proxy is not None:
            proxy.close()
        temporary_home.cleanup()


def command(raw_args):
    """原生命令返回本次明确请求，由桌面既有发送流程提交到所属会话。"""
    if not ENABLED:
        return DISABLED_MESSAGE
    task = raw_args.strip()
    return "/codex " + task if task else "用法：/codex <任务内容>"


def explicit_prompt(content):
    """只读取本轮斜杠命令的任务，保留换行；不再解析技能展开文本。"""
    import re

    if isinstance(content, list):
        content = "\n".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    match = (
        re.fullmatch(r"/codex(?:\s+([\s\S]+))?", content.strip(), re.IGNORECASE)
        if isinstance(content, str)
        else None
    )
    if not match or not (match.group(1) or "").strip():
        raise ValueError("请在本轮输入 /codex 加任务内容；普通消息不会启动 Codex。")
    return match.group(1).strip()


_context = None


def set_context(ctx):
    """保存原生插件上下文，参数交接复用其按 Profile 隔离的 state。"""
    global _context
    _context = ctx


def request_key(session_id):
    """将会话身份转成原生 state 的定长键，不保存历史任务。"""
    import hashlib

    return "codex." + hashlib.sha256(session_id.encode()).hexdigest()


def on_pre_llm_call(
    session_id="", turn_id="", user_message=None, parent_session_id="", **_
):
    """只保留本轮显式输入；队列中的后续消息不参与本轮任务。"""
    if not ENABLED:
        return
    from hermes_constants import get_hermes_home
    import psutil

    if not session_id or _context is None:
        return
    state = _context.state
    key = request_key(session_id)
    if state.get(key) is not None:
        state.set(key, None)
    if not turn_id or parent_session_id:
        return
    try:
        home = Path(get_hermes_home())
        prompt, cwd, session = invocation(home, session_id, user_message)
        owner = psutil.Process()
        state.set(
            key,
            {
                "turn_id": turn_id,
                "owner_pid": owner.pid,
                "owner_started": owner.create_time(),
                "prompt": prompt,
                "cwd": cwd,
                "session": session,
            },
        )
        return {
            "context": (
                "用户本轮明确执行数字员工 /codex 命令。请使用现有 terminal 工具，"
                "在当前会话工作目录前台执行 hermes kit codex，background=false，timeout=600。"
                "该命令自动读取本轮任务、当前会话所选模型和所属数字员工账号额度，"
                "不要传提示词或凭据，不要调用裸 codex 或读取个人 Codex 配置。"
                "依据工具输出报告实际结果，使用现有停止操作；用户停止后不要自行重启。"
                "临时失败按普通工具流程处理，不擅自换模型；组件准备失败不推断为额度不足。"
            )
        }
    except (ValueError, OSError):
        return


def on_post_llm_call(session_id="", turn_id="", **_):
    """原生轮次结束即清空参数，旧轮结束不能清掉新轮输入。"""
    if not session_id or _context is None:
        return
    key = request_key(session_id)
    data = _context.state.get(key)
    if data and data["turn_id"] == turn_id:
        _context.state.set(key, None)


def invocation(home: Path, session_id: str, content=None) -> tuple[str, str, dict]:
    """读取会话配置；任务仅来自正在执行的原生用户输入，不查询消息队列。"""
    from hermes_state import SessionDB

    prompt = explicit_prompt(content)
    if not session_id or not (home / "state.db").is_file():
        raise ValueError("请在会话中输入 /codex 加任务内容。")
    db = SessionDB(home / "state.db", read_only=True)
    try:
        session = db.get_session(session_id)
        if not session or session.get("source") in {"cron", "subagent"}:
            raise ValueError("请在会话中显式输入 /codex。")
        cwd = session.get("cwd")
        if not cwd or not Path(cwd).is_absolute() or not Path(cwd).is_dir():
            raise ValueError("请先为会话选择可用的工作文件夹。")
        metadata = session.get("model_config") or {}
        if isinstance(metadata, str):
            metadata = json.loads(metadata)
        fields = ("provider", "base_url", "api_mode")
        safe_route = {key: metadata[key] for key in fields if metadata.get(key)}
        gateway = metadata.get("gateway_runtime")
        if isinstance(gateway, dict):
            safe_route["gateway_runtime"] = {
                key: gateway[key] for key in fields if gateway.get(key)
            }
        selected = {"model": session.get("model"), "model_config": safe_route}
        return prompt, str(Path(cwd).resolve()), selected
    finally:
        db.close()


def desktop_runtime():
    """CLI 使用桌面已经选定的运行组件，避免 PATH 中旧安装副本缺少依赖。"""
    import os
    import sys
    import hermes_constants

    root = os.environ.get("HERMES_DESKTOP_HERMES_ROOT")
    python = os.environ.get("HERMES_DESKTOP_PYTHON")
    if (
        not root
        or not python
        or Path(hermes_constants.__file__).resolve().parent == Path(root).resolve()
    ):
        return
    root = Path(root).resolve()
    if (
        not Path(python).is_file()
        or not (root / "agent/transports/codex_chat_proxy.py").is_file()
    ):
        raise ValueError("Codex 运行组件不完整，请更新或修复应用安装。")
    code = (
        "import sys; sys.path.insert(0, "
        + repr(str(root))
        + "); from hermes_cli.main import main; main()"
    )
    os.execve(
        python,
        [python, "-I", "-B", "-c", code, "kit", "codex"],
        dict(os.environ),
    )


def account_model(home: Path, session: dict) -> dict:
    """沿用会话所选模型及提供方，只从所属数字员工账号读取对应凭据。"""
    import hashlib
    import re
    import hermes_yaml as yaml
    from dotenv import dotenv_values
    from .store import root_home

    account_home = root_home(home).resolve()
    marker = account_home.parent / "account-id"
    if not marker.is_file() or not re.fullmatch(
        r"account-[0-9a-f]{64}", marker.read_text().strip()
    ):
        raise ValueError("当前会话没有数字员工账号资源。")
    for file in (account_home / "config.yaml", account_home / ".env"):
        if file.is_symlink() or not file.is_file():
            raise ValueError("数字员工模型配置不可用，请重新登录。")
    config = yaml.safe_load((account_home / "config.yaml").read_text()) or {}
    # Desktop persists composer picks and model switches on the session row.
    # An unpinned provider follows this Profile, exactly as ordinary Hermes chats do.
    metadata = session.get("model_config") or {}
    if isinstance(metadata, str):
        metadata = json.loads(metadata)
    if not isinstance(metadata, dict):
        raise ValueError("无法读取当前会话的模型选择，请重新选择模型。")
    from hermes_state import SessionDB

    route = (
        {
            key: metadata[key]
            for key in ("provider", "base_url", "api_mode")
            if metadata.get(key)
        }
        if metadata.get("provider")
        else SessionDB.session_gateway_runtime(session)
    )
    provider_id = route.get("provider")
    if not provider_id:
        profile_config = yaml.safe_load((home / "config.yaml").read_text()) or {}
        provider_id = (profile_config.get("model") or {}).get("provider")
    provider_id = str(provider_id or "").removeprefix("custom:")
    provider = (config.get("providers") or {}).get(provider_id) or {}
    api = provider.get("api")
    model = session.get("model") or metadata.get("model")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("无法读取当前会话的模型选择，请重新选择模型。")
    forbidden = {
        "api_key",
        "key_cmd",
        "api_key_env",
        "keyEnv",
        "apiKey",
        "apiKeyEnv",
        "url",
        "baseUrl",
        "apiMode",
    }
    if (
        not isinstance(api, str)
        or provider_id != "desktop-mt-maas-" + hashlib.sha256(api.encode()).hexdigest()
        or provider.get("key_env") != "DESKTOP_MT_MAAS_API_KEY"
        or provider.get("transport") != "chat_completions"
        or provider.get("api_mode", "chat_completions") != "chat_completions"
        or provider.get("base_url", api).rstrip("/") != api.rstrip("/")
        or (
            route.get("base_url")
            and str(route["base_url"]).rstrip("/") != api.rstrip("/")
        )
        or route.get("api_mode", "chat_completions") != "chat_completions"
        or forbidden.intersection(provider)
        or model not in (provider.get("models") or {})
    ):
        raise ValueError("请在数字员工中选择账号套餐内的模型后再使用 /codex。")
    key = dotenv_values(account_home / ".env", interpolate=False).get(
        "DESKTOP_MT_MAAS_API_KEY"
    )
    if not key or not key.strip():
        raise ValueError("数字员工账号模型额度不可用，请检查套餐或重新登录。")
    return {"model": model, "base_url": api, "api_key": key}


def run() -> int:
    """原生命令通过 terminal 调用；无桌面 IPC、任务表或独立会话。"""
    if not ENABLED:
        print(DISABLED_MESSAGE, flush=True)
        return 2
    from hermes_constants import get_hermes_home
    from gateway.session_context import get_session_env

    try:
        import psutil

        desktop_runtime()
        home = Path(get_hermes_home())
        session_id = get_session_env("HERMES_SESSION_ID", "")
        data = (
            _context.state.get(request_key(session_id))
            if session_id and _context
            else None
        )
        if not data:
            raise ValueError("本轮未明确调用 /codex。")
        try:
            owner = psutil.Process(data["owner_pid"])
            live = owner.is_running() and owner.create_time() == data["owner_started"]
        except psutil.Error:
            live = False
        if not live:
            raise ValueError("本轮会话已经结束，请在会话中调用 /codex。")
        config = account_model(home, data["session"])
        config.update(prompt=data["prompt"], cwd=data["cwd"])
    except ValueError as exc:
        print(str(exc), flush=True)
        return 2
    except Exception:
        print("无法读取当前会话或数字员工账号配置。", flush=True)
        return 2
    try:
        return execute(config)
    except ImportError:
        print("Codex 运行组件不完整，请更新或修复应用安装。", flush=True)
        return 1
