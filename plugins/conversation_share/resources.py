"""只为快照正文实际引用的本机图片登记摘要，复用原生文件权限检查。"""

import hashlib
import re
from urllib.parse import unquote, urlsplit

from markdown_it import MarkdownIt


class ResourceError(ValueError):
    """图片无法完整固定时停止准备，不返回截断图片或本机文件错误细节。"""


def snapshot_images(messages: list[dict], cwd: str | None) -> list[dict]:
    """解析真实 Markdown 图片而非代码示例，文件内容改变时也生成不同快照。"""
    from fastapi import HTTPException
    from hermes_cli.web_server_files import _fs_path
    from hermes_cli.web_routers.files import _fs_regular_file, _fs_read_bytes

    parser = MarkdownIt("commonmark")
    references = set()
    for message in messages:
        for block in message["blocks"]:
            if block["type"] not in {"markdown", "reasoning"}:
                continue
            for token in parser.parse(block.get("text", "")):
                for child in token.children or []:
                    if child.type == "image":
                        references.add(child.attrGet("src") or "")
    assets = []
    total = 0
    if len(references) > 100:
        raise ResourceError("正文图片过多，无法生成完整分享页面。")
    for reference in sorted(references):
        scheme = urlsplit(reference).scheme.lower()
        if scheme in {"https", "http", "data"}:
            continue
        if scheme not in {"", "file"} and not re.match(r"^[a-zA-Z]:[\\/]", reference):
            raise ResourceError("正文图片使用了无法独立分享的临时地址。")
        try:
            target, info = _fs_regular_file(_fs_path(unquote(reference), cwd=cwd or ""))
            if target.suffix.lower() not in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"}:
                raise ResourceError("正文图片格式不支持独立分享。")
            if info.st_size + total > 2 * 1024 * 1024:
                raise ResourceError("正文图片超过 2 MB，未生成截断分享页面。")
            data = _fs_read_bytes(target, limit=2 * 1024 * 1024 + 1)
            total += len(data)
            if total > 2 * 1024 * 1024:
                raise ResourceError("正文图片超过 2 MB，未生成截断分享页面。")
            assets.append({"reference": reference, "path": str(target), "hash": hashlib.sha256(data).hexdigest()})
        except HTTPException as error:
            raise ResourceError("正文图片无法读取，请检查会话的图片来源。") from error
    return assets
