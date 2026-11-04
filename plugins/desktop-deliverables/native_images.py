"""桌面主模型读图：本地加载原图，精确限制已知的外部识图入口。"""

import json
from contextlib import contextmanager

from . import uploads

TOOL = "desktop_read_image"
# 只限制已确认语义的识图工具；同服务的生成、编辑、上传及其他 MCP 原样保留。
ANALYSIS_TOOLS = frozenset(
    f"mcp__{server}__analyze_image" for server in uploads.SERVERS
)
NOT_DELIVERED = (
    "图片未交付给当前模型，不能据此描述内容。请让用户重新以图片附件发送，或切换兼容的看图模型；"
    "不要反复加载同一图片，也不要改用 MCP 或辅助模型识图。"
)
GUIDANCE = (
    "当前主模型支持图片。消息中已有原图时直接分析，不重复调用识图工具。"
    f"只有路径（含视频抽帧）时，使用 {TOOL} 读取图片；它只加载图片，不调用其他模型。"
    "视频可用终端按问题抽关键帧并保留时间戳，声音需单独处理，不根据画面猜测。"
    "不要调用 MCP analyze_image 或 vision_analyze 代为识图，也不要改写脚本调用外部识图服务。"
    "若只有路径、OCR摘要或加载失败，不能声称看到原图。"
    "图片生成、编辑、搜索、文件上传、终端及其他 MCP/工具继续按任务正常使用。"
)
SCHEMA = {
    "name": TOOL,
    "description": (
        "读取本机图片供当前支持 image 的桌面模型直接分析，包括视频抽帧。"
        "只返回原图，不做 OCR、不调用 MCP 或辅助模型。已在消息中的图片无须重复读取。"
        "输入本机绝对路径；网络图片先用已有下载工具保存。失败时不要猜测图片内容。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "要查看的本机图片绝对路径"}
        },
        "required": ["path"],
        "additionalProperties": False,
    },
}


def remember_request(
    *, platform="", session_id="", turn_id="", model="", provider="", api_mode="", **_
):
    """记录本轮最近实际请求的模型，自动回退后不继续用旧模型判定。"""
    from . import _lock, current, scope

    if platform != "desktop" or not model or not provider:
        return
    with _lock:
        turn = current(scope(session_id), turn_id)
        if turn is not None:
            turn.image_runtime = {
                "model": model,
                "provider": provider,
                "api_mode": api_mode,
            }


@contextmanager
def runtime_scope(session_id, turn_id=""):
    """复用插件现有本轮状态，只为读图调用临时绑定身份，不缓存密钥。"""
    from . import _lock, current, scope
    from agent.auxiliary_client import _normalize_main_runtime, scoped_runtime_main

    with _lock:
        turn = current(scope(session_id), turn_id)
        image_runtime = dict(turn.image_runtime) if turn is not None else {}
    if not image_runtime:
        yield
        return
    runtime = _normalize_main_runtime(None)
    if runtime.get("provider") != image_runtime["provider"]:
        runtime["requested_provider"] = image_runtime["provider"]
    runtime.update(image_runtime)
    with scoped_runtime_main(runtime):
        yield


def active(*, platform=None, model=""):
    """按会话来源和当前绑定模型判断，能力未知或纯文本时不改变原流程。"""
    from gateway.session_context import get_session_env
    from agent.auxiliary_client import (
        _read_main_model,
        _read_main_provider,
        _runtime_main_value,
    )
    from agent.image_routing import _lookup_supports_vision
    from hermes_cli.config import load_config_readonly

    surface = (
        platform
        if platform is not None
        else (
            get_session_env("HERMES_SESSION_PLATFORM")
            or get_session_env("HERMES_SESSION_SOURCE")
        )
    )
    if surface != "desktop":
        return False
    return (
        _lookup_supports_vision(
            _read_main_provider(),
            model or _read_main_model(),
            load_config_readonly(),
            requested_provider=str(_runtime_main_value("requested_provider") or ""),
        )
        is True
    )


def before_turn(*, platform="", model="", **_):
    """通过原生本轮上下文提示，不改写系统提示、历史或工具列表。"""
    if active(platform=platform, model=model):
        return {"context": GUIDANCE}
    return None


def blocked_message(tool_name):
    """在上传/执行前拦住已知的重复识图入口，不匹配模糊关键字。"""
    if tool_name not in ANALYSIS_TOOLS and tool_name != "vision_analyze":
        return None
    if active():
        return f"当前模型支持直接看图，此识图调用未执行。已有原图请直接分析；仅有本机路径请用 {TOOL}。加载失败时请用户重新附图，不要绕过此限制请求其他识图服务。"
    return None


async def read_image(args, task_id=None, **_):
    """复用原生解码和图片预算，只读允许范围，不走辅助模型兜底。"""
    from agent.auxiliary_client import _runtime_main_value
    from tools.registry import tool_error
    from tools.vision_tools import (
        _should_use_native_vision_fast_path,
        _vision_analyze_native,
    )
    from gateway.session_context import get_session_env
    from . import workspace

    if not active():
        return tool_error(
            "此加载工具仅用于当前支持 image 的桌面模型；请沿用当前模型原有的图片处理方式。"
        )
    if (
        _runtime_main_value("api_mode") == "codex_app_server"
        or not _should_use_native_vision_fast_path()
    ):
        return tool_error("当前图片路由或接口不支持直接返回图片。" + NOT_DELIVERED)
    source = args.get("path") if isinstance(args, dict) else None
    cwd = uploads.working_folder(task_id)
    if not isinstance(source, str) or not source.strip() or cwd is None:
        return tool_error("需要可访问的本机图片路径。" + NOT_DELIVERED)
    path = uploads.resolve_path(source, cwd)
    session_id = get_session_env("HERMES_SESSION_ID") or ""
    # cd只改变相对路径的解析位置，不撤销会话已登记工作根内的帧图访问。
    if (
        path is None
        or not path.is_file()
        or not (
            uploads.allowed(path, session_id, cwd)
            or uploads.allowed(path, session_id, workspace(task_id))
        )
    ):
        return tool_error(
            "图片不在本会话可读取的附件或工作目录范围内。" + NOT_DELIVERED
        )
    from hermes_constants import get_hermes_home

    if reason := uploads.sensitive_reason(
        path, account_home=get_hermes_home().resolve()
    ):
        return tool_error(f"不能读取图片：{reason}。")
    result = await _vision_analyze_native(str(path), "", task_id=task_id)
    if isinstance(result, dict) and result.get("_multimodal"):
        ref = f"[Image attached at: {path}]"
        notes = result["content"][0]["text"].partition("\n\n")[2]
        result["content"][0]["text"] = (
            "请直接分析随本结果附带的原图。若本结果只有文字和路径，没有图片部件："
            + NOT_DELIVERED
            + f"\n\n{ref}"
            + (f"\n\n{notes}" if notes else "")
        )
        # 接口拒绝图像后原生层会取此摘要；不能把未送达冒充成已经看图。
        result["text_summary"] = json.dumps(
            {"error": NOT_DELIVERED, "path": str(path)}, ensure_ascii=False
        )
    return result


def register(ctx):
    """加入原生桌面工具集，能力变化只在执行时判定，不动态换工具快照。"""
    ctx.register_tool(
        name=TOOL,
        toolset="desktop_ui",
        schema=SCHEMA,
        handler=read_image,
        is_async=True,
        description=SCHEMA["description"],
    )
    ctx.register_hook("pre_llm_call", before_turn)
