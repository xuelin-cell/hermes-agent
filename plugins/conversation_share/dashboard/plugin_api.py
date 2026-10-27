"""桌面会话分享只读接口，使用现有 profile 路由、完整历史和租约。"""

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from plugins.conversation_share.snapshot import SnapshotError, build_snapshot

router = APIRouter()


class SnapshotRequest(BaseModel):
    """限制请求字段和大小，不接受客户端消息内容或来源证明。"""

    model_config = ConfigDict(extra="forbid")
    sessionId: str = Field(min_length=1, max_length=256)
    scope: Literal["session", "response"] = "session"
    responseRowId: int | None = Field(default=None, ge=1)
    includeProcess: bool = False
    locale: str = Field(default="zh", max_length=16)
    theme: Literal["light", "dark"] = "light"


def read_snapshot(request: SnapshotRequest, profile: str | None) -> dict:
    """绑定请求所属 profile 并只读打开数据库，读取失败不回退为不完整内存历史。"""
    from hermes_cli.web_server_cron import _cron_profile_home
    from hermes_cli.web_server_profiles import serving_profile_name
    from hermes_cli.web_server_sessions import _open_session_db_for_profile
    from hermes_constants import get_hermes_home

    # 自定义账号 Home 可能没有注册 profile 名；此时由所打开的 Home 数据库隔离身份。
    owner, home = _cron_profile_home(profile) if profile else (serving_profile_name() or None, get_hermes_home())
    db = _open_session_db_for_profile(profile, read_only=True)
    if db is None:
        raise SnapshotError("无法读取完整会话，请稍后重试。")
    try:
        return build_snapshot(db, request.model_dump(), owner=owner, profile_home=home)
    finally:
        db.close()


@router.post("/snapshot")
async def snapshot(request: SnapshotRequest, profile: str | None = None):
    """准备或重新核验快照，数据库错误不会被当作空会话成功返回。"""
    try:
        return await asyncio.to_thread(read_snapshot, request, profile)
    except SnapshotError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


class ArtifactSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sessionId: str = Field(min_length=1, max_length=256)
    path: str | None = Field(default=None, max_length=4096)
    content: str | None = Field(default=None, max_length=2 * 1024 * 1024)
    hash: str | None = Field(default=None, max_length=64)


class ArtifactVerification(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: ArtifactSource
    html: str = Field(min_length=1, max_length=2 * 1024 * 1024)


def cloud_origins():
    from hermes_cli.config import load_config
    from plugins.conversation_share.origins import current
    if not load_config().get("cloud_sharing", {}).get("enabled"):
        raise HTTPException(status_code=404, detail="Cloud sharing is not enabled")
    return current()


@router.post("/artifact/eligibility")
async def artifact_eligibility(source: ArtifactSource):
    return await asyncio.to_thread(lambda: cloud_origins().eligibility(source.model_dump(exclude_none=True)))


@router.post("/artifact/verify")
async def artifact_verify(request: ArtifactVerification):
    return await asyncio.to_thread(lambda: cloud_origins().verify(request.source.model_dump(exclude_none=True), request.html))


@router.post("/artifact/mark-uploaded")
async def artifact_mark_uploaded(source: ArtifactSource):
    await asyncio.to_thread(lambda: cloud_origins().mark_uploaded(source.sessionId))
    return {"ok": True}


@router.post("/artifact/revision")
async def artifact_revision():
    return {"revision": await asyncio.to_thread(lambda: cloud_origins().revision())}
