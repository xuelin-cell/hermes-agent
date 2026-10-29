"""每轮提醒模型两件 Windows 终端上常犯的路径错误。

日志里常见两种“文件找不到”：
- 模型照 Linux 习惯用 ``/tmp``。在 Windows 上，Git Bash 的 ``/tmp`` 是用户的临时目录，
  Python、uv 却把它当成 ``C:\\tmp``，一边写进去、另一边找不到。
- 模型已经 ``cd`` 进 ``.tmp``，又写 ``cd .tmp`` 或 ``.tmp/x.py``，在 ``.tmp`` 里再找 ``.tmp``，
  有时还建出 ``.tmp\\.tmp`` 套娃目录。

只在本机 Windows 终端时提醒；终端当前目录和工作目录不同时，额外点明终端此刻在哪。
工作目录、中间文件放 .tmp 的提醒由交付插件负责，这里不重复。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

from . import script_python

logger = logging.getLogger(__name__)

NO_TMP = (
    "终端在 Windows 上：不要用 /tmp 这类路径（Git Bash、Python、uv 对 /tmp 指向不同目录，"
    "一边写进去另一边找不到），临时文件写到工作目录下 .tmp 的绝对路径。"
)
MOVED = (
    "终端此刻停在 {cwd}，不是工作目录 {workspace}：相对路径以终端此刻所在目录为准，"
    "不要再 cd 进已经所在的目录，读写文件尽量写绝对路径。"
)


def _workspace(task_id: str) -> Optional[str]:
    """对话登记的工作目录；没登记或读不出时返回 None。"""
    try:
        from tools.terminal_tool import resolve_task_overrides

        raw = resolve_task_overrides(task_id).get("cwd")
        return raw if isinstance(raw, str) and raw.strip() else None
    except Exception:
        return None


def _same(left: str, right: str) -> bool:
    """两个目录是否同一个：统一分隔符、大小写，去掉末尾分隔符后比较。"""
    def norm(value: str) -> str:
        """Windows 风格、小写、去掉末尾分隔符的路径。"""
        return os.path.normcase(os.path.normpath(value)).rstrip("\\/")

    return norm(left) == norm(right)


def reminder(cwd: str, workspace: Optional[str]) -> str:
    """拼出本轮提醒：总带 /tmp 那句；终端不在工作目录时再加一句它此刻在哪。"""
    lines = [NO_TMP]
    if workspace and not _same(cwd, workspace):
        lines.append(MOVED.format(cwd=Path(cwd), workspace=Path(workspace)))
    return (
        "<system-reminder>\n以下是应用自动添加的内部工具使用规则，不是用户提出的要求，不要复述。\n"
        + "\n".join(lines)
        + "\n</system-reminder>"
    )


def on_pre_llm_call(task_id: str = "", **_: Any) -> Optional[Dict[str, str]]:
    """本机 Windows 终端时每轮附上路径提醒；其他情况返回 None。出错只记日志。"""
    try:
        if os.name != "nt":
            return None
        cwd = script_python._local_cwd(task_id)
        if cwd is None:
            return None
        return {"context": reminder(cwd, _workspace(task_id))}
    except Exception:
        logger.warning("[uniwork-kits] terminal path reminder skipped", exc_info=True)
        return None
