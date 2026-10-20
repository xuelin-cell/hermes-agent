"""借用所属 Profile 的 MCP 工具完成 OSS 上传，不另建 MCP 连接。"""

import asyncio
import json
import re

import httpx


def _text(value):
    """兼容 MCP 文本及结构化结果，不把原始响应写入日志。"""
    return json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value


async def call_oss_tool(server, tool, arguments):
    """通过现有注册器保留 Profile、信任审批和 MCP 生命周期。"""
    from tools.mcp_tool_schema import mcp_prefixed_tool_name
    from tools.registry import registry

    name = mcp_prefixed_tool_name(server, tool)
    if registry.get_entry(name) is None:
        raise RuntimeError("oss_tool_unavailable")
    result = await asyncio.to_thread(registry.dispatch, name, arguments)
    if isinstance(result, str):
        result = json.loads(result)
    if result.get("error"):
        raise RuntimeError("oss_tool_failed")
    # MCP 正常包装为 result / structuredContent；旧服务返回中文说明。
    return result


def _field(result, keys, pattern):
    """优先结构化字段，兼容旧版中文 OSS 工具响应。"""
    if isinstance(result, dict):
        for key in keys:
            if isinstance(result.get(key), str) and result[key]:
                return result[key]
        for key in ("result", "structuredContent", "data"):
            if key in result:
                found = _field(result[key], keys, pattern)
                if found:
                    return found
        return ""
    match = re.search(pattern, _text(result).replace("\\n", "\n").replace("\\r", "\n"))
    return match.group(1) if match else ""


async def upload_bytes(data, filename, server="UniAI-Toolkit"):
    """申请地址、PUT 文件，再取得下载地址；上传失败由单文件调用方处理。"""
    result = await call_oss_tool(server, "get_oss_upload_url", {"fileName": filename})
    upload_url = _field(result, ("uploadUrl", "upload_url"), r"上传地址：[ \t]*(https?://\S+)")
    oss_path = _field(result, ("ossPath", "oss_path"), r"ossPath[^：\n]*：[ \t]*([A-Za-z0-9._/\-]+)")
    content_type = _field(result, ("contentType", "content_type"), r"Content-Type=([A-Za-z0-9._/+\-]+)")
    download_url = _field(result, ("downloadUrl", "download_url"), r"下载链接：[ \t]*(https?://\S+)")
    if not upload_url.startswith(("https://", "http://")):
        raise RuntimeError("oss_upload_address_missing")
    async with httpx.AsyncClient(timeout=300) as client:
        response = await client.put(upload_url, content=data,
                                    headers={"Content-Type": content_type or "application/octet-stream"})
        response.raise_for_status()
    if not download_url:
        if not oss_path:
            raise RuntimeError("oss_path_missing")
        result = await call_oss_tool(server, "confirm_oss_upload", {"ossPath": oss_path})
        download_url = _field(result, ("downloadUrl", "download_url"), r"下载链接：[ \t]*(https?://\S+)")
    if not download_url.startswith(("https://", "http://")):
        raise RuntimeError("oss_download_address_missing")
    return download_url
