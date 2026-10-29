"""终端里补上两样 Windows 上常缺、模型又常用的东西：``python3`` 命令和 ``NODE_PATH``。

- Windows 只有 ``python``，没有 ``python3``；不少技能说明和模型习惯写 ``python3``，在终端里
  得到 ``python3: command not found``。这里在账号默认档案下放一个转接到 ``python`` 的
  ``python3``（Git Bash 用）和 ``python3.cmd``（命令提示符、PowerShell 用），并把这个目录
  追加到后端 PATH 末尾：电脑上已有真正的 python3 时，它排在前面，照常用它。
- Word / PPT 技能让模型 ``npm install -g docx`` 后再 ``node 脚本.js``，但 node 不会去全局目录
  找包，报 ``Cannot find module 'docx'``。这里把全局 npm 目录设成 ``NODE_PATH``；用户
  自己设过就不动。

后端进程的环境变量会传给终端，所以在插件加载时设一次即可。只在 Windows 上做；查全局 npm
目录要启动一次 npm，放在后台线程里，不拖慢插件加载。
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import MutableMapping, Optional

logger = logging.getLogger(__name__)

SHIM_DIR = "uniwork-shims"
MARK = "uniwork-kits python3 shim"
SHIMS = {
    "python3": f'#!/bin/sh\n# {MARK}: Windows 没有 python3 命令，转给 python。\nexec python "$@"\n',
    "python3.cmd": f"@echo off\r\nrem {MARK}: Windows 没有 python3 命令，转给 python。\r\npython %*\r\n",
}

_started = False
_guard = threading.Lock()


def write_shims(folder: Path) -> bool:
    """在 folder 里写好 python3 转接文件；已有别人写的同名文件时不覆盖。返回目录是否可用。"""
    folder.mkdir(parents=True, exist_ok=True)
    for name, text in SHIMS.items():
        path = folder / name
        try:
            # 按原始字节读，保留 .cmd 的 \r\n，内容没变就不重写。
            current = path.read_bytes().decode("utf-8", errors="replace")
        except FileNotFoundError:
            current = None
        if current is not None and MARK not in current:
            logger.info("[uniwork-kits] %s exists and is not ours; left as is", path)
            continue
        if current != text:
            path.write_text(text, encoding="utf-8", newline="")
    return True


def add_to_path(folder: Path, environ: MutableMapping[str, str]) -> None:
    """把 folder 追加到 PATH 末尾（已经在里面就不重复加），已有的 python3 仍然优先。"""
    entries = [entry for entry in environ.get("PATH", "").split(os.pathsep) if entry]
    if any(os.path.normcase(os.path.normpath(entry)) == os.path.normcase(os.path.normpath(str(folder)))
           for entry in entries):
        return
    environ["PATH"] = os.pathsep.join([*entries, str(folder)])


def global_node_modules(environ: MutableMapping[str, str], run=subprocess.run) -> Optional[str]:
    """全局 npm 包目录：先问 ``npm root -g``，问不到时用 Windows 上 npm 的默认位置 %APPDATA%\\npm\\node_modules。"""
    npm = shutil.which("npm", path=environ.get("PATH"))
    if npm:
        try:
            done = run([npm, "root", "-g"], capture_output=True, text=True, timeout=20,
                       env=dict(environ), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            folder = done.stdout.strip().splitlines()[-1] if done.returncode == 0 and done.stdout.strip() else ""
            if folder:
                return folder
        except (OSError, subprocess.SubprocessError, IndexError):
            logger.info("[uniwork-kits] npm root -g failed; using the default npm folder", exc_info=True)
    appdata = environ.get("APPDATA")
    return str(Path(appdata) / "npm" / "node_modules") if appdata else None


def set_node_path(environ: MutableMapping[str, str], run=subprocess.run) -> None:
    """用户没设过 NODE_PATH 时设成全局 npm 包目录。"""
    if environ.get("NODE_PATH"):
        return
    folder = global_node_modules(environ, run)
    if folder:
        environ["NODE_PATH"] = folder
        logger.info("[uniwork-kits] NODE_PATH set to %s", folder)


def setup(home: Path, environ: Optional[MutableMapping[str, str]] = None, *, background: bool = True) -> bool:
    """插件加载时调用：本进程只做一次；返回这次是否真的做了。"""
    global _started
    if os.name != "nt":
        return False
    with _guard:
        if _started:
            return False
        _started = True
    environ = os.environ if environ is None else environ
    try:
        from . import store

        folder = store.root_home(Path(home)) / SHIM_DIR
        if write_shims(folder):
            add_to_path(folder, environ)
    except Exception:
        logger.warning("[uniwork-kits] could not add the python3 command", exc_info=True)

    def node_path() -> None:
        """后台查全局 npm 目录并设 NODE_PATH；出错只记日志。"""
        try:
            set_node_path(environ)
        except Exception:
            logger.warning("[uniwork-kits] could not set NODE_PATH", exc_info=True)

    if background:
        threading.Thread(target=node_path, name="uniwork-kits-node-path", daemon=True).start()
    else:
        node_path()
    return True
