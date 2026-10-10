"""Server-side proxy for the UniWork account login APIs."""

from __future__ import annotations

import re

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/uniwork/auth", tags=["uniwork-auth"])

_AUTH_BASE = "https://maas.ai-yuanjing.com/app"
_PHONE_RE = re.compile(r"^1[3-9]\d{9}$")


class CaptchaCodeRequest(BaseModel):
    phone: str
    captchaCode: str
    captchaId: str


class SmsLoginRequest(BaseModel):
    phone: str
    smsCode: str


def _phone(value: str) -> str:
    value = value.strip()
    if not _PHONE_RE.fullmatch(value):
        raise HTTPException(status_code=422, detail="请输入有效的中国大陆手机号")
    return value


async def _proxy(method: str, path: str, *, json: dict | None = None) -> dict:
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.request(method, f"{_AUTH_BASE}{path}", json=json)
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="UniWork 登录服务暂时不可用") from exc

    if response.status_code >= 400:
        detail = payload.get("message") or payload.get("msg") or "UniWork 登录请求失败"
        raise HTTPException(status_code=response.status_code, detail=detail)
    return payload


@router.get("/captcha")
async def get_captcha() -> dict:
    return await _proxy("GET", "/login/captcha")


@router.post("/send-code")
async def send_code(request: CaptchaCodeRequest) -> dict:
    if not request.captchaCode.strip() or not request.captchaId.strip():
        raise HTTPException(status_code=422, detail="请输入图形验证码")
    return await _proxy(
        "POST",
        "/login/sendCode",
        json={
            "phone": _phone(request.phone),
            "captchaCode": request.captchaCode.strip(),
            "captchaId": request.captchaId.strip(),
        },
    )


@router.post("/sms-login")
async def sms_login(request: SmsLoginRequest) -> dict:
    if not request.smsCode.strip():
        raise HTTPException(status_code=422, detail="请输入短信验证码")
    return await _proxy(
        "POST",
        "/gateway/login/smsLogin",
        json={
            "phone": _phone(request.phone),
            "smsCode": request.smsCode.strip(),
            "origin": "app",
            "application": "uniwork",
        },
    )
