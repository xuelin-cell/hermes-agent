"""仅向固定平台认证端点校验凭据，不记录或返回平台令牌。"""
from __future__ import annotations

import asyncio

import httpx
from fastapi import HTTPException


def failure(code: str, status: int = 400) -> HTTPException:
    """给页面稳定的错误类型，避免平台原始响应泄漏凭据。"""
    return HTTPException(status, detail=code)


async def validate_credentials(platform: str, identifier: str, secret: str) -> None:
    """校验真实凭据；企业微信只握手，不启动监听和消息处理。"""
    try:
        if platform == "wecom":
            try:
                from aiohttp import ClientError
            except ImportError:
                raise failure("validation_unavailable", 503) from None
            from gateway.config import PlatformConfig
            from plugins.platforms.wecom.adapter import WeComAdapter

            adapter = WeComAdapter(PlatformConfig(extra={"bot_id": identifier, "secret": secret}))
            try:
                await asyncio.wait_for(adapter._open_connection(), timeout=12)
            except RuntimeError as exc:
                code = "credentials_rejected" if "errcode=" in str(exc) else "validation_network"
                raise failure(code) from None
            except ClientError:
                raise failure("validation_network", 502) from None
            finally:
                await adapter._cleanup_ws()
            return

        endpoint, payload, token_key = {
            "dingtalk": ("https://api.dingtalk.com/v1.0/oauth2/accessToken",
                         {"appKey": identifier, "appSecret": secret}, "accessToken"),
            "feishu": ("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
                       {"app_id": identifier, "app_secret": secret}, "tenant_access_token"),
        }[platform]
        async with httpx.AsyncClient(timeout=12, follow_redirects=False) as client:
            response = await client.post(endpoint, json=payload)
        if response.status_code >= 500 or response.status_code == 429:
            raise failure("validation_unavailable", 502)
        try:
            body = response.json()
        except ValueError:
            raise failure("validation_response", 502) from None
        if not isinstance(body, dict):
            raise failure("validation_response", 502)
        if response.status_code in {400, 401, 403} or body.get("code", 0) not in {0, "0", None}:
            raise failure("credentials_rejected")
        if not response.is_success or not isinstance(body.get(token_key), str) or not body[token_key].strip():
            raise failure("validation_response", 502)
    except (TimeoutError, httpx.TimeoutException):
        raise failure("validation_timeout", 504) from None
    except (httpx.RequestError, OSError):
        raise failure("validation_network", 502) from None
