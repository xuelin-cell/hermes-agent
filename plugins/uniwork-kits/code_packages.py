"""模型用 execute_code 写的 Python 代码，也能用上套件环境里装好的库。

execute_code 跑在 Hermes 自己的 Python 里，那里没有 pandas、pypdf、openpyxl 这些库，
模型写数据分析、读 PDF 的代码时常报 ``No module named 'pandas'``。套件环境（见
:mod:`.script_python`）已经装好了这些库，但 execute_code 不会去用它。

这里不换解释器（后端进程的 ``VIRTUAL_ENV`` 指向 Hermes 自己的环境，更新、重启都要读它，
不能改），而是在 ``pre_tool_call`` 里给代码开头补一句：把套件环境的库目录**追加**到
``sys.path`` 末尾。Hermes 自带的库仍然优先，自带环境里没有的才从套件环境里找。

只读已经建好的环境，不触发安装，几毫秒就返回；环境没建好、终端不在本机、代码里有
``from __future__``（必须是第一句）、Python 版本对不上时都不改代码，照原样执行。
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from . import script_python

logger = logging.getLogger(__name__)

MARK = "_uk_sys"
_FUTURE_RE = re.compile(r"^\s*from\s+__future__\s+import\b", re.MULTILINE)
_VERSION_RE = re.compile(r"^\s*version_info\s*=\s*(\d+)\.(\d+)", re.MULTILINE)


def site_packages(python: Path) -> Optional[Tuple[Path, Tuple[int, int]]]:
    """环境的库目录和它的 Python 主次版本；目录不在或读不出版本时返回 None。"""
    venv = python.parent.parent
    try:
        found = re.search(_VERSION_RE, (venv / "pyvenv.cfg").read_text(encoding="utf-8"))
    except OSError:
        return None
    if not found:
        return None
    version = (int(found.group(1)), int(found.group(2)))
    candidates = [venv / "Lib" / "site-packages", venv / "lib" / f"python{version[0]}.{version[1]}" / "site-packages"]
    folder = next((path for path in candidates if path.is_dir()), None)
    return (folder, version) if folder else None


def with_packages(code: str, folder: Path, version: Tuple[int, int]) -> Optional[str]:
    """在代码开头补上追加库目录的一句；已经补过、或代码里有 from __future__ 时返回 None。"""
    if MARK in code or _FUTURE_RE.search(code):
        return None
    line = (
        f"import sys as _uk_sys; _uk_p = {str(folder)!r}; "
        f"_uk_sys.version_info[:2] == {version!r} and _uk_p not in _uk_sys.path and _uk_sys.path.append(_uk_p); "
        "del _uk_sys, _uk_p"
    )
    # 能接在同一行时就不多占一行，报错时的行号和模型写的一致：空行直接替换，
    # 注释接在后面，顶格的 import 用分号接上；其余情况（def、for、续行等）另起一行。
    first, newline, rest = code.partition("\n")
    if not first.strip():
        return line + newline + rest
    if first.startswith("#"):
        return f"{line}  {first}{newline}{rest}"
    if first.startswith(("import ", "from ")) and not first.rstrip().endswith("\\"):
        return f"{line}; {first}{newline}{rest}"
    return f"{line}\n{code}"


def on_pre_tool_call(tool_name: str = "", args: Any = None, task_id: str = "", **_: Any) -> Optional[Dict[str, Any]]:
    """execute_code 运行前给代码补上套件环境的库目录；不是 execute_code 或用不上时返回 None。"""
    try:
        if tool_name != "execute_code" or not isinstance(args, dict) or not isinstance(args.get("code"), str):
            return None
        if script_python._local_cwd(task_id) is None:
            return None
        from hermes_constants import get_hermes_home

        python = script_python.interpreter(Path(get_hermes_home()))
        found = site_packages(python) if python else None
        if not found:
            return None
        code = with_packages(args["code"], *found)
        return {"action": "modify", "args": {**args, "code": code}} if code else None
    except Exception:
        logger.warning("[uniwork-kits] could not add script packages to execute_code", exc_info=True)
        return None
