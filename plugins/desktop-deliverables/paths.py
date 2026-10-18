"""沿用 uniwork-kits 的路径识别方式，集中核对交付文件和有界快照。"""

import os
from pathlib import Path
import re
import stat
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
    r"^[ \t]*MEDIA:[ \t]*(`[^`\n]+`|\"[^\"\n]+\"|'[^'\n]+'|\S+)[ \t]*(?:\r?\n|$)", re.M
)
LINKS = re.compile(r"\]\(\s*<?([^)>\n]+)>?\s*\)")
_PREVIEW = re.compile(r"::preview\{[^}\n]*?\bfile\s*=\s*([\"'])(.*?)\1[^}\n]*\}")


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


def shown_paths(text, cwd):
    """复用原版 MEDIA 与示例屏蔽规则；独立行交给追加选择后处理。"""
    from gateway.platforms.base import MEDIA_TAG_CLEANUP_RE, _mask_media_scan_text

    text = MEDIA.sub("", _mask_media_scan_text(text))
    values = [
        match.group(1)
        for match in LINKS.finditer(text)
        if not match.group(1).lstrip().startswith("MEDIA:")
    ]
    # Markdown 尖括号是包装，原版扫描器以空白识别同一个路径终点。
    values += [
        match.group("path")
        for match in MEDIA_TAG_CLEANUP_RE.finditer(text.replace(">", " "))
    ]
    values += [match.group(2) for match in _PREVIEW.finditer(text)]
    return {path for value in values if (path := resolve_path(value, cwd)) is not None}


def remove_media_lines(text, cwd, moved):
    """只收拢被移走行附近的空白；代码、引用及其它段落不作全局压缩。"""
    from gateway.platforms.base import _mask_media_scan_text

    matches = list(MEDIA.finditer(_mask_media_scan_text(text)))
    for match in reversed(matches):
        if resolve_path(match.group(1), cwd) not in moved:
            continue
        start, end = match.span()
        left = re.search(r"(?:\r?\n[ \t]*)+$", text[:start])
        right = re.match(r"(?:[ \t]*\r?\n)*", text[end:])
        start = left.start() if left else start
        end += right.end()
        around = text[start:end]
        newline = "\r\n" if "\r\n" in around else "\n"
        separator = newline * min(2, max(1, around.count("\n") - 1))
        text = (
            text[:start] + (separator if start and end < len(text) else "") + text[end:]
        )
    return text


def is_link(path):
    """使用 3.11 已有的 lstat 识别符号链接和 Windows 目录联接；新目录可尚不存在。"""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or getattr(
        info, "st_reparse_tag", None
    ) == getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", -1)


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


def snapshot(root, budget=None):
    """四层、三千项、半秒内比较文件元数据；不完整快照不用来声称文件是本轮新建。"""
    budget = budget if budget is not None else [time.monotonic(), 0]
    result = {}

    def walk_error(error):
        """仅尚未创建的观察根可视为空，其它遍历失败使整份快照失效。"""
        if not (
            isinstance(error, FileNotFoundError)
            and error.filename
            and Path(error.filename) == root
        ):
            raise error

    try:
        for folder, directories, files in os.walk(
            root, followlinks=False, onerror=walk_error
        ):
            budget[1] += len(directories) + len(files)
            if budget[1] > 3000 or time.monotonic() - budget[0] > 0.5:
                return None
            directories[:] = [
                name
                for name in directories
                if not name.startswith(".")
                and name.lower() not in EXCLUDED
                and len((Path(folder) / name).relative_to(root).parts) < 4
                and not is_link(Path(folder) / name)
            ]
            for name in files:
                if time.monotonic() - budget[0] > 0.5:
                    return None
                path = Path(folder) / name
                if eligible(path) and not is_link(path):
                    info = path.stat()
                    result[path.resolve()] = (info.st_mtime_ns, info.st_size)
    except OSError:
        # 包含 lstat 的权限错误：不能把漏读文件的部分结果当成完整基线。
        return None
    return result


def known_folders():
    """Windows 使用系统已重定向的用户目录，其它系统使用标准用户目录名。"""
    folders = {
        name: Path.home() / name for name in ("Desktop", "Downloads", "Documents")
    }
    if os.name == "nt":
        import winreg

        names = {
            "Desktop": "Desktop",
            "Downloads": "{374DE290-123F-4565-9164-39C4925E467B}",
            "Documents": "Personal",
        }
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
        ) as key:
            for name, value in names.items():
                try:
                    raw = winreg.QueryValueEx(key, value)[0]
                    folders[name] = Path(os.path.expandvars(raw))
                except FileNotFoundError:
                    continue
    return folders


def requested_roots(text, cwd):
    """只扫描工作目录和用户本次明示的目录，最多四个，不扫描泛指的整个磁盘。"""
    roots = [cwd]
    candidates = [
        next(value for value in match.groups() if value is not None)
        for match in _QUOTED.finditer(text)
    ]
    candidates += re.findall(_ROOT + r'[^\n`"<>|*?，。；！？、）)\]}]+', text)
    aliases = {
        "Desktop": r"(?:到|在|至)桌面|\b(?:to|in|on) (?:the )?desktop\b",
        "Downloads": r"(?:到|在|至)下载(?:目录|文件夹)?|\b(?:to|in) (?:the )?downloads\b",
        "Documents": r"(?:到|在|至)文档(?:目录|文件夹)?|\b(?:to|in) (?:the )?documents\b",
    }
    selected = [
        name for name, pattern in aliases.items() if re.search(pattern, text, re.I)
    ]
    if selected:
        folders = known_folders()
        candidates += [str(folders[name]) for name in selected if name in folders]
    for raw in candidates[:64]:
        path = resolve_path(raw, cwd)
        directory = path and (
            path.is_dir()
            or (
                not path.exists()
                and Path(raw).expanduser().is_absolute()
                and not path.suffix
            )
        )
        if directory and path.parent != path and path not in roots:
            roots.append(path)
        if len(roots) == 4:
            break
    return roots


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
