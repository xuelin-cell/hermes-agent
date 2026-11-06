"""标题元数据入口；由既有桌面鉴权及Profile路由约束，不接受文件路径或模型凭据。"""
import asyncio
import importlib.util
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

spec = importlib.util.spec_from_file_location("uniwork_titles_dashboard_runtime", Path(__file__).parent.parent / "runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
router = APIRouter()

class SeedRequest(BaseModel):
    """只接收提交成功后已有会话的最小标题依据。"""
    model_config = ConfigDict(extra="forbid")
    sessionId: str = Field(min_length=1, max_length=256, pattern=r"^[A-Za-z0-9_-]+$")
    temporary: str = Field(min_length=1, max_length=256)
    intent: str = Field(default="", max_length=1800)


def scoped_seed(request, profile):
    """复用原生Profile验证，只打开路由确定的Home，不信任页面提供绝对路径。"""
    from hermes_cli.web_server_cron import _cron_profile_home
    from hermes_constants import get_hermes_home
    home = _cron_profile_home(profile)[1] if profile else get_hermes_home()
    return {"ok": runtime.seed(home, request.sessionId, request.temporary, request.intent, from_ui=True)}


@router.post("/seed")
async def seed(request: SeedRequest, profile: str | None = None):
    """主请求已经提交，标题保存失败只保留输入预览，不让正文发送失败。"""
    try:
        return await asyncio.to_thread(scoped_seed, request, profile)
    except (ValueError, OSError):
        raise HTTPException(status_code=409, detail="标题暂未保存") from None
