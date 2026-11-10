"""桌面消息配置：先验证，后写入；只接受固定凭据和平台准入设置。"""
from __future__ import annotations

import asyncio
from importlib import import_module
from pathlib import Path
import subprocess
import sys
import time
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hermes_cli.config import load_env, remove_env_value, save_env_value
from hermes_cli.web_routers._common import is_redacted_credential_preview
from hermes_cli.web_server_messaging import _messaging_platform_catalog, _write_platform_enabled
from hermes_cli.web_server_profiles import _config_profile_scope

validate_credentials = import_module("plugins.desktop-messaging.dashboard.validation").validate_credentials
presentation = import_module("plugins.desktop-messaging.dashboard.presentation")
router = APIRouter()
KEYS = {
    "dingtalk": ("DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET"),
    "feishu": ("FEISHU_APP_ID", "FEISHU_APP_SECRET"),
    "wecom": ("WECOM_BOT_ID", "WECOM_SECRET"),
}
POLICIES = {
    "dingtalk": {"DINGTALK_ALLOW_ALL_USERS": "true"},
    "feishu": {"FEISHU_ALLOW_ALL_USERS": "true", "FEISHU_GROUP_POLICY": "open"},
    "wecom": {"WECOM_ALLOW_ALL_USERS": "true", "WECOM_DM_POLICY": "open", "WECOM_GROUP_POLICY": "open"},
}
_locks: dict[str, asyncio.Lock] = {}
_gateway_lock = asyncio.Lock()


@router.get("/platforms")
def platform_status(profile: str | None = None) -> dict:
    """钉钉配置按账号文件判断，连接状态仍复用原版进程存活与多 Profile 投影。"""
    from hermes_cli.web_routers.messaging import _platform_payloads
    from hermes_constants import get_hermes_home

    with _config_profile_scope(profile) as scoped:
        entries = _messaging_platform_catalog()
        # 当前后端的插件注册失败不等于网关进程未连接；其它平台保持原版判断。
        rows = _platform_payloads(scoped, [entry for entry in entries if entry["id"] != "dingtalk"])
        rows += _platform_payloads(get_hermes_home(), [entry for entry in entries if entry["id"] == "dingtalk"])
        by_id = {row["id"]: row for row in rows}
        return {"platforms": [by_id[entry["id"]] for entry in entries]}


def _managed_profiles() -> list:
    """沿用原版受管范围，拒绝链接到其它账号的 Profile。"""
    from hermes_cli.profiles import profiles_to_serve
    from hermes_cli.web_server_gateway import _has_own_gateway
    from hermes_constants import get_default_hermes_root

    root = get_default_hermes_root().resolve()
    profiles = []
    for name, home in profiles_to_serve(True):
        expected = root if name == "default" else root / "profiles" / name
        if home.resolve() != expected or (name != "default" and expected.parent.resolve() != root / "profiles"):
            raise HTTPException(409, detail="gateway_identity_unverified")
        if name != "default" and _has_own_gateway(home):
            continue
        profiles.append((name, home))
    return profiles


def _owned_gateway() -> bool:
    """复用前核对原版 PID、创建时间及实时 Home；归属不明时拒绝启动。"""
    import psutil
    from gateway.status import get_running_pid, get_running_pid_identity_strict, get_runtime_status_running_pid, read_runtime_status
    from hermes_constants import get_default_hermes_root

    home = get_default_hermes_root().resolve()
    identity = get_running_pid_identity_strict(home / "gateway.pid")
    if identity is None:
        if get_runtime_status_running_pid(read_runtime_status(home / "gateway_state.json"), expected_home=home):
            raise RuntimeError("unverified_gateway")
        return False
    process = psutil.Process(identity[0])
    env_home = process.environ().get("HERMES_HOME")
    if not env_home or (
        get_running_pid(home / "gateway.pid", cleanup_stale=False) != identity[0]
        or home != Path(env_home).resolve()
    ):
        raise RuntimeError("unverified_gateway")
    return True


class Setup(BaseModel):
    """页面只能修改必要凭据及启用状态。"""
    model_config = ConfigDict(extra="forbid")
    env: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True


def _write_policies(platform: str) -> bool:
    """只补写本平台固定规则，不使用影响微信的全局放行开关。"""
    env = load_env()
    changed = False
    for key, value in POLICIES[platform].items():
        if env.get(key) != value:
            save_env_value(key, value)
            changed = True
    return changed


def _read_platform(platform: str) -> tuple[dict[str, str], bool]:
    """从当前作用域读配置，不借用其它账号的进程环境。"""
    from hermes_cli.web_routers.messaging import _platform_enablement, _require_platform

    env = load_env()
    enabled, _, _ = _platform_enablement(platform, _require_platform(platform), env, True)
    return env, enabled


@router.put("/platforms/{platform}")
async def save_platform(platform: Literal["dingtalk", "feishu", "wecom"], body: Setup,
                        profile: str | None = None) -> dict:
    """在固定 Profile 校验后保存；同一后端的并发保存按 Home 串行。"""
    from hermes_constants import get_hermes_home

    with _config_profile_scope(profile):
        home = str(get_hermes_home())
    async with _locks.setdefault(home, asyncio.Lock()):
        with _config_profile_scope(profile):
            env, enabled = _read_platform(platform)
        keys = KEYS[platform]
        if set(body.env) - set(keys):
            raise HTTPException(400, detail="invalid_credentials_fields")
        edits = {key: value.strip() for key, value in body.env.items() if value.strip()}
        if any(is_redacted_credential_preview(value) for value in edits.values()):
            raise HTTPException(400, detail="invalid_credentials_fields")
        changed = any(env.get(key) != value for key, value in edits.items())
        if body.enabled:
            identifier, secret = (edits.get(key, env.get(key, "")) for key in keys)
            if not identifier or not secret:
                raise HTTPException(400, detail="credentials_required")
            if edits.get(keys[0], identifier) != env.get(keys[0]) and keys[1] not in edits:
                raise HTTPException(400, detail="secret_required_for_new_id")
            if changed:
                await validate_credentials(platform, identifier, secret)
        with _config_profile_scope(profile):
            if body.enabled:
                for key, value in edits.items():
                    if env.get(key) != value:
                        save_env_value(key, value)
                changed = _write_policies(platform) or changed
                changed = presentation.prepare_presentation({platform}) or changed
            else:
                for key in keys:
                    if env.get(key):
                        remove_env_value(key)
                        changed = True
            if enabled != body.enabled:
                # 与扫码线程共用 config.yaml 锁，避免整文件回写互相覆盖。
                with presentation.config_lock():
                    _write_platform_enabled(platform, body.enabled)
                changed = True
        return {"ok": True, "changed": changed}


@router.post("/prepare")
async def prepare() -> dict:
    """只按主助手判断消息平台并补写规则，供启动及解绑后选择动作。

    专家助手没有独立消息平台：它们 .env 里的凭据是建立时从主助手整份复制的，原版网关因凭据
    重复只服务主助手。计入专家只会逐个加载插件、白扫配置，并让桌面等待永远连不上的专家。
    """
    from hermes_constants import get_hermes_home

    # 加载插件、读写配置都是阻塞操作，放到工作线程里做；留在事件循环上会让整个后端停止应答，
    # 冷启动时桌面其它请求和本次恢复请求都会超时。作用域在线程内进入，锁仍按 Home 串行。
    # 记忆展示桌面聊天也读取，仍覆盖全部受管助手；只读写配置、不加载插件，不因此重启网关。
    for profile, profile_home in await asyncio.to_thread(_managed_profiles):
        async with _locks.setdefault(str(profile_home), asyncio.Lock()):
            await asyncio.to_thread(_prepare_memory, profile)
    with _config_profile_scope("default"):
        home = str(get_hermes_home())
    async with _locks.setdefault(home, asyncio.Lock()):
        targets, changed = await asyncio.to_thread(_prepare_main_platforms)
    configured = bool(targets)
    return {"configured": configured, "changed": changed, "profiles": ["default"] if configured else []}


def _prepare_memory(profile: str) -> None:
    """在工作线程里为一个受管助手准备记忆展示。"""
    with _config_profile_scope(profile):
        presentation.prepare_memory_notifications()


def _prepare_main_platforms() -> tuple[set[str], bool]:
    """在工作线程里按主助手找出已启用平台，补写平台规则和展示设置，返回平台集合与是否有变化。"""
    from hermes_cli.web_routers.messaging import _platform_enablement

    changed = False
    targets = set()
    with _config_profile_scope("default"):
        env = load_env()
        for entry in _messaging_platform_catalog():
            enabled, complete, _ = _platform_enablement(entry["id"], entry, env, True)
            if enabled and complete:
                targets.add(entry["id"])
                if entry["id"] in POLICIES:
                    changed = _write_policies(entry["id"]) or changed
        changed = presentation.prepare_presentation(targets) or changed
        # 原版停机广播读取宿主配置，主助手就是宿主。
        changed = presentation.prepare_presentation(targets, host_only=True) or changed
    return targets, changed


def _gateway_environment(state: dict) -> dict[str, str]:
    """受管网关关闭忙碌回执，将各适配器的断开等待限制为一秒。"""
    env = {"HERMES_GATEWAY_INSTALL_START_ON_LOGIN": "0",
           "HERMES_GATEWAY_ADAPTER_DISCONNECT_TIMEOUT": "1"}
    if state["configured"]:
        env["HERMES_GATEWAY_BUSY_ACK_ENABLED"] = "false"
        # 默认模板的顶层 display.busy_steer_ack_enabled 会被转成环境变量并盖过平台设置；进程环境优先。
        env["HERMES_GATEWAY_BUSY_STEER_ACK_ENABLED"] = "false"
    return env


def _spawn_desktop_gateway(env_overrides: dict[str, str]) -> subprocess.Popen:
    """沿用原版账号环境、动作日志及登记，只替换常驻网关入口。"""
    from hermes_cli import web_server_gateway as actions
    from hermes_cli._launchers import resolve_store_python
    from hermes_cli._subprocess_compat import windows_detach_flags
    from hermes_cli.web_server import PROJECT_ROOT
    from hermes_constants import get_default_hermes_root

    subcommand = ["-p", "default", "gateway", "run"]
    env = actions._profile_action_environment(subcommand, env_overrides)
    if not env.get("HERMES_HOME") or Path(env["HERMES_HOME"]).resolve() != get_default_hermes_root().resolve():
        raise RuntimeError("gateway_identity_unverified")
    root = Path(PROJECT_ROOT).resolve()
    python = resolve_store_python(root) or Path(sys.executable)
    script = Path(__file__).resolve().parents[1] / "desktop-gateway.py"
    name = "gateway-start"
    actions._ACTION_LOG_DIR.mkdir(parents=True, exist_ok=True)
    detach = {"creationflags": windows_detach_flags()} if sys.platform == "win32" else {"start_new_session": True}
    with open(actions._ACTION_LOG_DIR / actions._ACTION_LOG_FILES[name], "ab", buffering=0) as log_file:
        log_file.write(f"\n=== {name} started {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n".encode())
        proc = subprocess.Popen(
            [str(python), "-I", str(script), str(root)], cwd=str(root), stdin=subprocess.DEVNULL,
            stdout=log_file, stderr=subprocess.STDOUT, env=env, **detach,
        )
    actions._ACTION_RESULTS.pop(name, None)
    actions._ACTION_COMMANDS[name] = tuple(subcommand)
    actions._ACTION_PROCS[name] = proc
    if env_overrides.get("HERMES_ACTION_ID"):
        actions._ACTION_IDS[name] = env_overrides["HERMES_ACTION_ID"]
    else:
        actions._ACTION_IDS.pop(name, None)
    return proc


async def _restore_gateway(state: dict, restart: bool) -> dict:
    """在调用方已持有网关锁时复用、停止或启动，避免两个入口嵌套加锁。"""
    from hermes_cli.web_server_gateway import _gateway_subcommand, _spawn_hermes_action

    if not state["configured"]:
        return {**state, "name": None}
    try:
        running = await asyncio.to_thread(_owned_gateway)
    except Exception as exc:
        raise HTTPException(409, detail="gateway_identity_unverified") from exc
    if running and not (state["changed"] or restart):
        return {**state, "name": None}
    env = _gateway_environment(state)
    if running:
        # 只发起原版停止；桌面确认动作成功后再次请求恢复，不能走会拉起原版入口的 restart。
        await asyncio.to_thread(_spawn_hermes_action, _gateway_subcommand("default", "stop"),
                                "gateway-stop", env_overrides=env)
    else:
        await asyncio.to_thread(_spawn_desktop_gateway, env)
    return {**state, "name": "gateway-stop" if running else "gateway-start"}


@router.post("/restore")
async def restore_gateway(restart: bool = False) -> dict:
    """后台恢复复用可信进程；仅规则变化或用户明确重试时重新连接。"""
    async with _gateway_lock:
        return await _restore_gateway(await prepare(), restart)


@router.post("/apply")
async def apply_gateway() -> dict:
    """保存后先停再由桌面恢复；没有配置时保持原版只停止的返回格式。"""
    from hermes_cli.web_server_gateway import _gateway_subcommand, _spawn_hermes_action

    async with _gateway_lock:
        state = await prepare()
        if state["configured"]:
            return await _restore_gateway(state, restart=True)
        name = "gateway-stop"
        proc = await asyncio.to_thread(_spawn_hermes_action, _gateway_subcommand("default", "stop"), name,
                                       env_overrides=_gateway_environment(state))
        return {"ok": True, "name": name, "pid": proc.pid}
