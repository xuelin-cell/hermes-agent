"""只为快照正文实际引用的本机图片登记摘要，复用原生文件权限检查。"""

import hashlib
import re
from urllib.parse import unquote, urlsplit

from markdown_it import MarkdownIt


# 与 uniclaw-shares 网关所在服务的 SHARE_MAX_BYTES 默认值一致（5,000,000 字节）。
_LIMIT = 5_000_000


# 单次分享最多登记的本机图片数量；超出的部分按「未能嵌入」处理。
_MAX_IMAGES = 100
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"}


def snapshot_images(messages: list[dict], cwd: str | None) -> list[dict]:
    """解析真实 Markdown 图片而非代码示例，文件内容改变时也生成不同快照。

    图片不阻止分享：读不到、格式不支持、超出数量或总大小的本机图片不登记，前端在原位置显示占位并在发布前提示。
    """
    from fastapi import HTTPException
    from hermes_cli.web_server_files import _fs_path
    from hermes_cli.web_routers.files import _fs_regular_file, _fs_read_bytes

    parser = MarkdownIt("commonmark")
    references = set()
    for message in messages:
        for block in [*message["blocks"], *message.get("process", [])]:
            if block["type"] not in {"markdown", "reasoning"}:
                continue
            for token in parser.parse(block.get("text", "")):
                for child in token.children or []:
                    if child.type == "image":
                        references.add(child.attrGet("src") or "")
    assets = []
    total = 0
    for reference in sorted(references):
        scheme = urlsplit(reference).scheme.lower()
        if scheme in {"https", "http", "data"}:
            continue
        if len(assets) >= _MAX_IMAGES:
            break
        if scheme not in {"", "file"} and not re.match(r"^[a-zA-Z]:[\\/]", reference):
            continue
        try:
            target, info = _fs_regular_file(_fs_path(unquote(reference), cwd=cwd or ""))
        except HTTPException:
            continue
        if target.suffix.lower() not in _IMAGE_SUFFIXES or info.st_size + total > _LIMIT:
            continue
        try:
            data = _fs_read_bytes(target, limit=_LIMIT + 1)
        except HTTPException:
            continue
        if total + len(data) > _LIMIT:
            continue
        total += len(data)
        assets.append({"reference": reference, "path": str(target), "hash": hashlib.sha256(data).hexdigest()})
    return assets
