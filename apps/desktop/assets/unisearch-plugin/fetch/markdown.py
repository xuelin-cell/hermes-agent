"""Markdown text processing utilities."""

from __future__ import annotations

import re


# 清除链接／图片语法时保护代码段，避免破坏代码正文。
def strip_links_and_images(text: str) -> str:
    """Remove images and convert links to plain text, preserving code blocks.

    Args:
        text: Markdown text to process.

    Returns:
        Text with ![alt](url) removed and [text](url) converted to text.
    """
    if not text:
        return text

    placeholders: list[str] = []

    # 先占位保存代码内容，使后续链接清理不会改写代码。
    def protect(match: re.Match[str]) -> str:
        placeholders.append(match.group(0))
        return f"\x00{len(placeholders) - 1}\x00"

    result = re.sub(r"```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`", protect, text)

    url = r"\([^()]*(?:\([^()]*\)[^()]*)*\)"
    result = re.sub(rf"!\[[^\]]*\]{url}", "", result)
    result = re.sub(rf"\[([^\]]+)\]{url}", r"\1", result)
    result = re.sub(rf"\[\]{url}", "", result)

    for i, original in enumerate(placeholders):
        result = result.replace(f"\x00{i}\x00", original)

    return result
