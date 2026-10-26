"""桌面消息配置：先验证，后写入；只接受固定凭据和平台准入设置。"""
from __future__ import annotations

import asyncio
from importlib import import_module
from pathlib import Path
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
    """检查本账号受管环境并补写已启用平台规则，供启动及解绑后选择动作。"""
    from hermes_constants import get_hermes_home

    profiles = await asyncio.to_thread(_managed_profiles)
    configured = False
    changed = False
    configured_profiles = []
    active_platforms = set()
    for profile, home in profiles:
        async with _locks.setdefault(str(home), asyncio.Lock()):
            with _config_profile_scope(profile):
                from hermes_cli.web_routers.messaging import _platform_enablement

                # 每个受管环境均准备记忆展示，不因这项变更重启网关。
                presentation.prepare_memory_notifications()
                env = load_env()
                targets = set()
                for entry in _messaging_platform_catalog():
                    enabled, complete, _ = _platform_enablement(entry["id"], entry, env, True)
                    if enabled and complete:
                        active_platforms.add(entry["id"])
                        targets.add(entry["id"])
                        configured = True
                        if profile not in configured_profiles:
                            configured_profiles.append(profile)
                        if entry["id"] in POLICIES:
                            changed = _write_policies(entry["id"]) or changed
                changed = presentation.prepare_presentation(targets) or changed
    # 原版停机广播读取宿主配置；子 Profile 独有的平台也要在宿主关掉广播。
    with _config_profile_scope("default"):
        default_home = str(get_hermes_home())
    async with _locks.setdefault(default_home, asyncio.Lock()):
        with _config_profile_scope("default"):
            changed = presentation.prepare_presentation(
                active_platforms, host_only=True) or changed
    return {"configured": configured, "changed": changed, "profiles": configured_profiles}


def _gateway_environment(state: dict) -> dict[str, str]:
    """受管网关统一关闭忙碌回执，包含混用或只有 5G 的情况。"""
    env = {"HERMES_GATEWAY_INSTALL_START_ON_LOGIN": "0"}
    if state["configured"]:
        env["HERMES_GATEWAY_BUSY_ACK_ENABLED"] = "false"
        # 默认模板的顶层 display.busy_steer_ack_enabled 会被转成环境变量并盖过平台设置；进程环境优先。
        env["HERMES_GATEWAY_BUSY_STEER_ACK_ENABLED"] = "false"
    return env


@router.post("/restore")
async def restore_gateway(restart: bool = False) -> dict:
    """后台恢复复用可信进程；仅规则变化或用户明确重试时重新连接。"""
    from hermes_cli.web_server_gateway import _gateway_subcommand, _spawn_hermes_action

    async with _gateway_lock:
        state = await prepare()
        if not state["configured"]:
            return {**state, "name": None}
        try:
            running = await asyncio.to_thread(_owned_gateway)
        except Exception as exc:
            raise HTTPException(409, detail="gateway_identity_unverified") from exc
        if running and not (state["changed"] or restart):
            return {**state, "name": None}
        # 运行期直接用原版 run 启动，不调用可能修复／启用系统自动启动项的 start。
        # 旧准入规则变化时先停止，主进程确认动作结束后再调用本入口启动。
        verb = "stop" if running else "run"
        name = "gateway-stop" if running else "gateway-start"
        await asyncio.to_thread(_spawn_hermes_action, _gateway_subcommand("default", verb), name,
                                env_overrides=_gateway_environment(state))
        return {**state, "name": name}


@router.post("/apply")
async def apply_gateway() -> dict:
    """由桌面串行调用原版动作；无配置时停止，不复用旧凭据的重启冷却结果。"""
    from hermes_cli.web_server_gateway import _gateway_subcommand, _spawn_hermes_action

    async with _gateway_lock:
        state = await prepare()
        verb = "restart" if state["configured"] else "stop"
        name = f"gateway-{verb}"
        proc = await asyncio.to_thread(_spawn_hermes_action, _gateway_subcommand("default", verb), name,
                                       env_overrides=_gateway_environment(state))
        return {"ok": True, "name": name, "pid": proc.pid}
