"""给套件和专家的 Python 脚本准备带好依赖的解释器，并在终端命令里换上它。

内置包里的脚本（基金诊断取数、Word / PPT / Excel 处理等）要 pandas、lxml 这些库。
Hermes 自己的环境里没有它们；正式安装版的终端里甚至没有 Hermes 的 Python：模型写
``python3 scripts/get_data.py`` 时，用到的是用户自己装的 Python，或者 Windows 的应用商店占位程序。

这里用 PM 的独立工具环境（``pm.ensure_environment``），在账号默认档案下建
``environments/kits``，装 ``script-requirements.txt`` 里的库，专家档案共用这一份。
它不进 Hermes 主环境，不改核心依赖和锁文件，也不影响 PM 对主环境的一致性检查。

终端命令要运行 ``skills/kits/`` 或 ``imported-plugins/`` 下的脚本时，``pre_tool_call`` 把各段开头的
``python`` / ``python3`` / ``py`` 换成这个环境的解释器。其他命令一律不动；终端不在本机
（Docker、SSH）时也不动，那边用不了本机路径。环境在后端启动时就在后台建（见 autoseed），
第一次跑脚本时如果还没建好，最多等 ``WAIT_S`` 秒；建不成就保持原命令。

只有个别脚本要、又特别重的库（``ON_DEMAND``，例如缠论脚本的 czsc，会多出约 700 MB）不进这个环境，
也不随安装包发：第一次跑到那个脚本时，再单独建一个「基础清单 + 这个库」的环境，之后一直复用。
"""

from __future__ import annotations

import logging
import os
import re
import shlex
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import store

logger = logging.getLogger(__name__)

# 名字故意短：环境里最深的原生 DLL 已经贴近 Windows 260 字符上限，DLL 不受长路径设置影响，超了就加载失败。
ENV_NAME = "kits"
REQUIREMENTS_FILE = Path(__file__).with_name("script-requirements.txt")
WAIT_S = 300
BUILD_TIMEOUT_S = 1800

# 用到时再装：脚本文件名 → （环境名后缀, 额外依赖）。czsc 1.0 去掉了缠论脚本要的 czsc.signals，只能用 0.9 系列。
ON_DEMAND: Dict[str, Tuple[str, Tuple[str, ...]]] = {
    "chan_theory.py": ("czsc", ("czsc>=0.9.60,<0.10",)),
}

# 套件和专家技能装在 <档案>/skills/kits/<包>/；技能里的包根占位符换成了 <档案>/imported-plugins/<包>/<版本>/。
_KIT_PATH_RE = re.compile(r"(?:skills[\\/]+kits|imported-plugins)[\\/]", re.IGNORECASE)
# 命令每一段开头的解释器：允许前面带 VAR=值 的环境变量设置；py 启动器可以带 -3 / -3.12。
_LAUNCHER_RE = re.compile(
    r"(?P<lead>^|&&|\|\||[;|(\n])(?P<space>[ \t]*)(?P<env>(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*)"
    r"(?P<python>python3?(?:\.\d+)?(?:\.exe)?|py(?:\.exe)?(?:[ \t]+-3(?:\.\d+)?)?)(?=[ \t]|$)",
)

_guard = threading.Lock()
_root_locks: Dict[str, threading.Lock] = {}


def requirements() -> List[str]:
    """读脚本依赖清单，去掉空行和注释。"""
    lines = REQUIREMENTS_FILE.read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")]


def environment_root(home: Path, name: str = ENV_NAME) -> Path:
    """独立环境放在账号默认档案的 environments/ 下，专家档案共用这一份。"""
    return store.root_home(Path(home)) / "environments" / name


def interpreter(home: Path, name: str = ENV_NAME) -> Optional[Path]:
    """已经建好的环境里的解释器；还没建好或读不出来时返回 None。只读，不会触发安装。"""
    try:
        import pm

        return pm.environment_python(name, root=environment_root(home, name))
    except Exception:
        return None


def _root_lock(root: Path) -> threading.Lock:
    """同一个账号的环境在本进程里同时只建一次，其他调用排队等它。"""
    with _guard:
        return _root_locks.setdefault(str(root), threading.Lock())


def prepare(home: Path, *, wait: Optional[float] = None, name: str = ENV_NAME,
            extra: Sequence[str] = ()) -> Optional[Path]:
    """建好环境，或确认已经是最新的，返回解释器；失败或等不到时返回 None。

    依赖清单变了（应用更新）时 PM 会建新的一代，旧的那一代保留到新的建好。
    wait 是排队等别的调用建完的最长秒数，None 表示一直等。name / extra 用于「用到时再装」的环境。
    """
    root = environment_root(home, name)
    lock = _root_lock(root)
    if not lock.acquire(timeout=-1 if wait is None else wait):
        return None
    try:
        import pm

        python = Path(pm.ensure_environment(name, [*requirements(), *extra], root=root, explicit=True,
                                            timeout=BUILD_TIMEOUT_S))
        logger.info("[uniwork-kits] script environment %s ready: %s", name, python)
        return python
    except Exception:
        logger.warning("[uniwork-kits] could not prepare the script environment %s", name, exc_info=True)
        return None
    finally:
        lock.release()


def environment_for(command: str) -> Tuple[str, Tuple[str, ...]]:
    """这条命令该用哪个环境：跑到「用到时再装」的脚本时用它专门的环境，否则用基础环境。"""
    for script, (suffix, extra) in ON_DEMAND.items():
        if re.search(rf"(?<![\w.-]){re.escape(script)}(?![\w.-])", command):
            return f"{ENV_NAME}-{suffix}", extra
    return ENV_NAME, ()


def runs_kit_script(command: str, cwd: Optional[str]) -> bool:
    """命令是不是在跑套件或专家目录下的脚本：命令里写了这些目录，或者终端当前就在这些目录里。"""
    return bool(_KIT_PATH_RE.search(command) or (cwd and _KIT_PATH_RE.search(cwd.rstrip("\\/") + "/")))


def rewrite_command(command: str, python: str) -> Optional[str]:
    """把命令各段开头的 python / python3 / py 换成指定的解释器（按 bash 规则加引号）；没有可换的返回 None。"""
    quoted = shlex.quote(python)
    new, count = _LAUNCHER_RE.subn(lambda m: f"{m.group('lead')}{m.group('space')}{m.group('env')}{quoted}", command)
    return new if count else None


def _local_cwd(task_id: str) -> Optional[str]:
    """本机终端的当前目录；终端在 Docker、SSH 这类非本机后端时返回 None。"""
    try:
        from tools.terminal_tool import _get_env_config, get_session_cwd

        config = _get_env_config()
        if config.get("env_type") != "local":
            return None
        return str(get_session_cwd(task_id) or config.get("cwd") or os.getcwd())
    except Exception:
        return None


def on_pre_tool_call(tool_name: str = "", args: Any = None, task_id: str = "", **_: Any) -> Optional[Dict[str, Any]]:
    """终端命令要用 python 跑套件或专家的脚本时，改成独立环境里的解释器；其他情况返回 None，不改命令。"""
    if tool_name != "terminal" or not isinstance(args, dict):
        return None
    command = args.get("command")
    if not isinstance(command, str) or not _LAUNCHER_RE.search(command):
        return None
    cwd = _local_cwd(task_id)
    if cwd is None or not runs_kit_script(command, cwd):
        return None
    from hermes_constants import get_hermes_home

    home = Path(get_hermes_home())
    name, extra = environment_for(command)
    from hermes_cli.config import load_config_readonly

    if (load_config_readonly().get('cloud_kits') or {}).get('enabled'):
        # Cloud templates carry the script libraries; never install a new environment per user.
        if extra:
            return {"action": "block", "reason": "此脚本需要当前云端模板尚未预装的扩展依赖。"}
        import sys

        python = Path(sys.executable)
    else:
        python = interpreter(home, name) or prepare(home, wait=WAIT_S, name=name, extra=extra)
    if python is None:
        return None
    new = rewrite_command(command, python.as_posix())
    return {"action": "modify", "args": {"command": new}} if new else None
