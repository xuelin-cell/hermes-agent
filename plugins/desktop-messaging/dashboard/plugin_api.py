"""桌面消息配置：先验证，后写入；只接受固定凭据和平台准入设置。"""
from __future__ import annotations

import asyncio
from importlib import import_module
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hermes_cli.config import load_env, remove_env_value, save_env_value
from hermes_cli.web_routers._common import is_redacted_credential_preview
from hermes_cli.web_server_messaging import _messaging_platform_catalog, _write_platform_enabled
from hermes_cli.web_server_profiles import _config_profile_scope

validate_credentials = import_module("plugins.desktop-messaging.dashboard.validation").validate_credentials
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
            else:
                for key in keys:
                    if env.get(key):
                        remove_env_value(key)
                        changed = True
            if enabled != body.enabled:
                _write_platform_enabled(platform, body.enabled)
                changed = True
        return {"ok": True, "changed": changed}


@router.post("/prepare")
async def prepare() -> dict:
    """检查本账号受管环境并补写已启用平台规则，供启动及解绑后选择动作。"""
    from hermes_cli.profiles import profiles_to_serve

    profiles = [name for name, _ in await asyncio.to_thread(profiles_to_serve, True)]
    configured = False
    changed = False
    for profile in profiles:
        with _config_profile_scope(profile):
            from hermes_cli.web_routers.messaging import _platform_enablement

            env = load_env()
            for entry in _messaging_platform_catalog():
                enabled, complete, _ = _platform_enablement(entry["id"], entry, env, True)
                if enabled and complete:
                    configured = True
                    if entry["id"] in POLICIES:
                        changed = _write_policies(entry["id"]) or changed
    return {"configured": configured, "changed": changed}


@router.post("/apply")
async def apply_gateway() -> dict:
    """由桌面串行调用原版动作；无配置时停止，不复用旧凭据的重启冷却结果。"""
    from hermes_cli.web_server_gateway import _gateway_subcommand, _spawn_hermes_action

    state = await prepare()
    verb = "restart" if state["configured"] else "stop"
    name = f"gateway-{verb}"
    proc = await asyncio.to_thread(_spawn_hermes_action, _gateway_subcommand("default", verb), name)
    return {"ok": True, "name": name, "pid": proc.pid}
