"""已保存模型的连接检测；密钥仅在所属 Profile 的后端使用。"""

import asyncio

from fastapi import APIRouter, HTTPException

from agent.secret_scope import get_secret_str
from hermes_cli.config import read_raw_config
from hermes_cli.config_providers import find_provider_entry
from hermes_cli.web_models import CustomEndpointUpdate
from hermes_cli.web_routers.config_env import validate_custom_endpoint
from hermes_cli.web_server_profiles import _config_profile_scope

router = APIRouter()


def _probe_body(
    body: CustomEndpointUpdate, profile: str | None
) -> CustomEndpointUpdate:
    """补入本 Profile 的已存 Key；地址改变时禁止沿用旧凭据。"""
    with _config_profile_scope(profile):
        if body.api_key and body.api_key.strip():
            return body
        _, entry = find_provider_entry(read_raw_config().get("providers"), body.id)
        if entry is None:
            raise HTTPException(400, detail="Enter an API key to test this endpoint.")
        saved_url = str(
            entry.get("base_url") or entry.get("url") or entry.get("api") or ""
        )
        if saved_url.strip().rstrip("/") != body.base_url.strip().rstrip("/"):
            raise HTTPException(
                400, detail="Enter an API key to test the changed endpoint URL."
            )
        key_env = str(entry.get("key_env") or entry.get("api_key_env") or "").strip()
        key = (
            get_secret_str(key_env, "") if key_env else str(entry.get("api_key") or "")
        )
        if key.startswith("${") and key.endswith("}"):
            key = get_secret_str(key[2:-1], "")
        return body.model_copy(update={"api_key": key.strip()})


@router.post("/validate")
async def validate_model(
    body: CustomEndpointUpdate, profile: str | None = None
) -> dict:
    """复用原版模型目录和协议探测，不保存草稿或返回秘密。"""
    prepared = await asyncio.to_thread(_probe_body, body, profile)
    return await validate_custom_endpoint(prepared)
