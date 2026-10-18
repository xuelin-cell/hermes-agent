"""沿用 uniwork-kits 的路径识别方式，集中核对交付文件和有界快照。"""

import os
from pathlib import Path
import re
import time
from urllib.parse import unquote, urlsplit

EXTENSIONS = {
    "docx",
    "doc",
    "xlsx",
    "xls",
    "pptx",
    "ppt",
    "pdf",
    "md",
    "html",
    "htm",
    "csv",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "mp3",
    "wav",
    "m4a",
    "mp4",
    "mov",
    "webm",
    "zip",
}
EXCLUDED = {
    "node_modules",
    ".git",
    "__pycache__",
    "venv",
    ".venv",
    "site-packages",
    "themes",
    "templates",
    "references",
    "scripts",
    "assets",
    "examples",
}
IMAGES = {"png", "jpg", "jpeg", "gif", "webp", "svg"}
DOCUMENTS = {"docx", "doc", "xlsx", "xls", "pptx", "ppt", "pdf"}
_EXT = "|".join(sorted(EXTENSIONS))
_ROOT = r"(?<![\w:/\\.])(?:/?[A-Za-z]:[\\/]|~[\\/]|/(?![/\\]))"
_STOP = r"\s\"'<>|*?`，。；：！？、（）()【】\[\]{}"
_ABSOLUTE = re.compile(
    _ROOT + "[^" + _STOP + "]+?" + r"\.(?:" + _EXT + r")(?![A-Za-z0-9])", re.I
)
_BARE = re.compile(r"(?<![\w./\\-])([\w.-]+\.(?:" + _EXT + r"))(?![A-Za-z0-9])", re.I)
_QUOTED = re.compile(r"`([^`\n]+)`|\"([^\"\n]+)\"|'([^'\n]+)'|\]\(<?([^)>\n]+)>?\)")
MEDIA = re.compile(
    r"^[ \t]*MEDIA:[ \t]*(`[^`\n]+`|\"[^\"\n]+\"|'[^'\n]+'|\S+)[ \t]*$", re.M
)
LINKS = re.compile(r"\]\(\s*<?([^)>\n]+)>?\s*\)")


def resolve_path(value, cwd):
    """只解析本机路径；拒绝 URL、UNC 和设备路径，避免证据核对访问网络。"""
    if not isinstance(value, str):
        return None
    raw = value.strip().strip("`\"'").rstrip(".,;!?，。；！？")
    if raw.startswith("file://"):
        parsed = urlsplit(raw)
        if parsed.netloc not in {"", "localhost"}:
            return None
        raw = unquote(parsed.path)
    if os.name == "nt":
        raw = re.sub(r"^/([A-Za-z]:[/\\])", r"\1", raw)
    if not raw or "://" in raw or raw.startswith(("\\\\", "//")):
        return None
    try:
        path = Path(raw).expanduser()
        return (path if path.is_absolute() else cwd / path).resolve()
    except (OSError, ValueError):
        return None


def named_paths(text, cwd):
    """识别完整路径、带空格的引用以及交付目录中的文件名；不遍历目录猜文件。"""
    text = text[:200_000] if isinstance(text, str) else ""
    quoted = [
        next(value for value in match.groups() if value is not None)
        for match in _QUOTED.finditer(text)
    ]
    complete_lines = [
        line
        for line in text.splitlines()
        if re.search(r"\.(?:" + _EXT + r")$", line, re.I)
    ]
    paths = [
        resolve_path(value, cwd)
        for value in quoted
        + complete_lines
        + [match.group(1) for match in MEDIA.finditer(text)]
    ]
    folders = [cwd]
    for path in paths:
        if path and path.is_dir() and path not in folders:
            folders.append(path)
    paths += [resolve_path(match.group(), cwd) for match in _ABSOLUTE.finditer(text)]
    paths += [
        folder / match.group(1) for match in _BARE.finditer(text) for folder in folders
    ]
    return list(dict.fromkeys(path for path in paths if path is not None))


def eligible(path):
    """只认交付白名单，排除隐藏文件、Office 锁文件及工具素材目录。"""
    return (
        path.suffix.lower().lstrip(".") in EXTENSIONS
        and not path.name.startswith("~$")
        and not any(
            part.startswith(".") or part.lower() in EXCLUDED for part in path.parts
        )
    )


def fresh(path, since):
    """交付必须存在、非空且在本轮创建或修改；时间只容忍两秒时钟偏差。"""
    try:
        stat = path.stat()
        return (
            eligible(path)
            and path.is_file()
            and stat.st_size > 0
            and max(stat.st_mtime, getattr(stat, "st_birthtime", 0)) >= since - 2
        )
    except (OSError, ValueError):
        return False


def snapshot(root):
    """四层、三千项、半秒内比较文件元数据；不完整快照不用来声称文件是本轮新建。"""
    started = time.monotonic()
    result = {}
    count = 0
    for folder, directories, files in os.walk(root, followlinks=False):
        count += len(directories) + len(files)
        if count > 3000 or time.monotonic() - started > 0.5:
            return None
        directories[:] = [
            name
            for name in directories
            if not name.startswith(".")
            and name.lower() not in EXCLUDED
            and not (Path(folder) / name).is_symlink()
            and not (Path(folder) / name).is_junction()
            and len((Path(folder) / name).relative_to(root).parts) < 4
        ]
        for name in files:
            if time.monotonic() - started > 0.5:
                return None
            path = Path(folder) / name
            if eligible(path) and not path.is_symlink():
                try:
                    stat = path.stat()
                    result[path.resolve()] = (stat.st_mtime_ns, stat.st_size)
                except OSError:
                    continue
    return result


def priority(path):
    """文档、文本、图片、音视频依次排列，同类保持证据出现顺序。"""
    extension = path.suffix.lower().lstrip(".")
    if extension in DOCUMENTS:
        return 0
    if extension in {"md", "html", "htm", "csv", "zip"}:
        return 1
    return 2 if extension in IMAGES else 3


def media_line(path):
    """含空格的绝对路径沿用桌面现有反引号格式。"""
    shown = str(path)
    return f"MEDIA:`{shown}`" if re.search(r"\s", shown) else f"MEDIA:{shown}"
