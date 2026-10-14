"""微信扫码连接：桌面消息页使用的后端接口，挂载在 ``/api/plugins/weixin-qr/``。

终端版 ``hermes gateway setup`` 用 ``gateway.platforms.weixin.qr_login`` 把二维码打印到终端，
页面拿不到二维码内容。这里复用同一套 iLink 请求函数，把二维码内容交给页面展示；扫码确认后
按终端版的写法保存凭据，默认只允许扫码人本人私聊、关闭群聊，再重启消息网关。
token 只留在后端，任何接口都不返回它。
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

from gateway.platforms import weixin as wx

_log = logging.getLogger(__name__)

router = APIRouter()

PLATFORM_ID = "weixin"
BOT_TYPE = "3"
# 与 UniWork 相同：一次登录最长等 5 分钟；二维码过期就结束，由用户在页面上重新生成。
LOGIN_TIMEOUT_S = 300
POLL_INTERVAL_S = 1.0
# 结束的登录保留一段时间，让页面读到最终状态。
FINISHED_TTL_S = 600
CDN_DEFAULT = "https://novac2c.cdn.weixin.qq.com/c2c"
_CREDENTIAL_KEYS = ("WEIXIN_ACCOUNT_ID", "WEIXIN_TOKEN", "WEIXIN_BASE_URL")
_ACCOUNT_FILE_SUFFIXES = (".json", ".sync.json", ".context-tokens.json")
_FINISHED = frozenset({"confirmed", "expired", "error", "cancelled"})


@dataclass
class _Login:
    """一次进行中的扫码登录。state：wait / scanned / confirmed / expired / error / cancelled。"""

    id: str
    profile: Optional[str]
    qrcode: str
    qr_content: str
    state: str = "wait"
    message: str = ""
    restart: dict[str, Any] = field(default_factory=dict)
    task: Optional[asyncio.Task] = None
    finished_at: float = 0.0


_logins: dict[str, _Login] = {}


def _payload(login: _Login) -> dict[str, Any]:
    """页面可见的登录状态；二维码内容只是扫码链接，不含凭据。"""
    body: dict[str, Any] = {
        "session_id": login.id, "state": login.state, "qr_content": login.qr_content, "message": login.message}
    if login.state == "confirmed":
        body.update(login.restart)
        body["needs_restart"] = not login.restart.get("restart_started", False)
    return body


def _finish(login: _Login, state: str, message: str = "") -> None:
    """记录登录的最终状态。"""
    login.state, login.message, login.finished_at = state, message, time.monotonic()


def _prune() -> None:
    """清掉结束已久的登录记录。"""
    now = time.monotonic()
    for key, login in list(_logins.items()):
        if login.state in _FINISHED and now - login.finished_at > FINISHED_TTL_S:
            _logins.pop(key, None)


def _cancel(login: _Login) -> None:
    """停止后台等待；已结束的登录保持原状。"""
    if login.state in _FINISHED:
        return
    if login.task is not None:
        login.task.cancel()
    _finish(login, "cancelled")


def _account_files(home: Path, account_id: str) -> list[Path]:
    """某个微信账号在 Hermes 目录中的凭据与同步文件；账号 ID 不是普通文件名时不处理。"""
    if not account_id or Path(account_id).name != account_id or account_id in {".", ".."}:
        return []
    root = home / "weixin" / "accounts"
    return [root / f"{account_id}{suffix}" for suffix in _ACCOUNT_FILE_SUFFIXES]


def _apply(profile: Optional[str], creds: dict[str, str]) -> None:
    """在目标 Profile 保存凭据和默认权限：只允许扫码人本人私聊，关闭群聊，主动消息发给本人。"""
    from hermes_cli.config import get_env_value, save_env_value
    from hermes_cli.web_server_messaging import _write_platform_enabled
    from hermes_cli.web_server_profiles import _profile_scope
    from hermes_constants import get_hermes_home

    with _profile_scope(profile):
        wx.save_weixin_account(str(get_hermes_home()), **creds)
        user_id = creds.get("user_id", "")
        values = {
            "WEIXIN_ACCOUNT_ID": creds["account_id"],
            "WEIXIN_TOKEN": creds["token"],
            "WEIXIN_BASE_URL": creds.get("base_url") or wx.ILINK_BASE_URL,
            "WEIXIN_CDN_BASE_URL": get_env_value("WEIXIN_CDN_BASE_URL") or CDN_DEFAULT,
            "WEIXIN_ALLOW_ALL_USERS": "false",
            "WEIXIN_GROUP_POLICY": "disabled",
            "WEIXIN_GROUP_ALLOWED_USERS": "",
        }
        if user_id:
            values.update(WEIXIN_DM_POLICY="allowlist", WEIXIN_ALLOWED_USERS=user_id, WEIXIN_HOME_CHANNEL=user_id)
        else:
            # 没拿到扫码人 ID 时无法建名单，退回终端版推荐的配对审批。
            values.update(WEIXIN_DM_POLICY="pairing", WEIXIN_ALLOWED_USERS="")
        for key, value in values.items():
            save_env_value(key, value)
        _write_platform_enabled(PLATFORM_ID, True)


def _unbind(profile: Optional[str]) -> None:
    """清除目标 Profile 的微信凭据、关闭微信通道；只删除当前绑定账号自己的凭据文件。"""
    from hermes_cli.config import get_env_value, remove_env_value
    from hermes_cli.web_server_messaging import _write_platform_enabled
    from hermes_cli.web_server_profiles import _profile_scope
    from hermes_constants import get_hermes_home

    with _profile_scope(profile):
        account_id = (get_env_value("WEIXIN_ACCOUNT_ID") or "").strip()
        for key in _CREDENTIAL_KEYS:
            remove_env_value(key)
        _write_platform_enabled(PLATFORM_ID, False)
        for path in _account_files(Path(get_hermes_home()), account_id):
            path.unlink(missing_ok=True)


def _restart(profile: Optional[str]) -> dict[str, Any]:
    """保存后尽力重启消息网关；失败只报告，由页面提示手动重启。"""
    from hermes_cli.web_server_gateway import _restart_gateway_after

    return _restart_gateway_after(profile, what="Weixin QR login", label="Weixin QR login")


def _credentials(resp: dict[str, Any]) -> dict[str, str]:
    """从确认响应中取出凭据，字段与终端版 qr_login 一致。"""
    return {
        "account_id": str(resp.get("ilink_bot_id") or ""),
        "token": str(resp.get("bot_token") or ""),
        "base_url": str(resp.get("baseurl") or wx.ILINK_BASE_URL),
        "user_id": str(resp.get("ilink_user_id") or ""),
    }


async def _watch(login: _Login) -> None:
    """后台轮询扫码状态；确认后保存配置并重启网关。"""
    deadline = time.monotonic() + LOGIN_TIMEOUT_S
    base_url = wx.ILINK_BASE_URL
    try:
        async with wx._new_session() as session:
            while time.monotonic() < deadline:
                try:
                    resp = await wx._api_get(
                        session, base_url=base_url, endpoint=f"{wx.EP_GET_QR_STATUS}?qrcode={login.qrcode}",
                        timeout_ms=wx.QR_TIMEOUT_MS)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    # 长轮询超时是正常情况；网络抖动也只重试，不终止登录。
                    if not isinstance(exc, asyncio.TimeoutError):
                        _log.warning("weixin-qr: status poll failed: %s", exc)
                    await asyncio.sleep(POLL_INTERVAL_S)
                    continue
                status = str(resp.get("status") or "wait")
                if status == "scaned":
                    login.state = "scanned"
                elif status == "scaned_but_redirect" and resp.get("redirect_host"):
                    base_url = f"https://{resp['redirect_host']}"
                elif status == "expired":
                    _finish(login, "expired")
                    return
                elif status == "confirmed":
                    creds = _credentials(resp)
                    if not creds["account_id"] or not creds["token"]:
                        _finish(login, "error", "WeChat confirmed the login but returned incomplete credentials.")
                        return
                    try:
                        await asyncio.to_thread(_apply, login.profile, creds)
                    except Exception:
                        _log.exception("weixin-qr: saving credentials failed")
                        _finish(login, "error", "Could not save the WeChat connection.")
                        return
                    login.restart = await asyncio.to_thread(_restart, login.profile)
                    _finish(login, "confirmed")
                    return
                await asyncio.sleep(POLL_INTERVAL_S)
        _finish(login, "expired")
    except asyncio.CancelledError:
        if login.state not in _FINISHED:
            _finish(login, "cancelled")
        raise
    except Exception:
        _log.exception("weixin-qr: login watcher failed")
        _finish(login, "error", "WeChat login stopped unexpectedly.")


@router.post("/login/start")
async def start_login(profile: Optional[str] = None) -> dict[str, Any]:
    """取一张新二维码并在后台等待扫码；同一 Profile 之前未完成的登录会被取消。"""
    if not wx.check_weixin_requirements():
        raise HTTPException(status_code=503, detail="Weixin needs aiohttp and cryptography.")
    _prune()
    for login in list(_logins.values()):
        if login.profile == profile:
            _cancel(login)
    try:
        async with wx._new_session() as session:
            qrcode, qr_content = await wx._fetch_qr(session, BOT_TYPE)
    except Exception as exc:
        _log.warning("weixin-qr: QR fetch failed: %s", exc)
        raise HTTPException(status_code=502, detail="Could not get a QR code from WeChat.") from exc
    if not qrcode:
        raise HTTPException(status_code=502, detail="WeChat returned an empty QR code.")
    login = _Login(id=secrets.token_urlsafe(12), profile=profile, qrcode=qrcode, qr_content=qr_content or qrcode)
    _logins[login.id] = login
    login.task = asyncio.create_task(_watch(login))
    return _payload(login)


@router.get("/login/{session_id}")
async def login_status(session_id: str) -> dict[str, Any]:
    """读取扫码登录的当前状态。"""
    login = _logins.get(session_id)
    if login is None:
        raise HTTPException(status_code=404, detail="This WeChat login is no longer available.")
    return _payload(login)


@router.post("/unbind")
async def unbind(profile: Optional[str] = None) -> dict[str, Any]:
    """解绑微信：清除凭据、关闭微信通道并重启消息网关。"""
    for login in list(_logins.values()):
        if login.profile == profile:
            _cancel(login)
    try:
        await asyncio.to_thread(_unbind, profile)
    except Exception as exc:
        _log.exception("weixin-qr: unbind failed")
        raise HTTPException(status_code=500, detail="Could not remove the WeChat connection.") from exc
    restart = await asyncio.to_thread(_restart, profile)
    return {"ok": True, **restart, "needs_restart": not restart.get("restart_started", False)}
