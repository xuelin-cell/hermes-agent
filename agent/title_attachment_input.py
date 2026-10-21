"""会话命名只提取附件前缀之后的问题，不读取或改写附件。"""

from re import Pattern


def title_request_text(message: str, references: Pattern[str], footer: Pattern[str]) -> str:
    """跳过开头的附件引用及展开尾注，保留问题正文中的内联引用。"""
    text = footer.sub('', message).strip()
    while match := references.match(text):
        text = text[match.end():].lstrip()
    return text
