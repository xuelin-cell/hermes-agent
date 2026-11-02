"""终端补上 python3 命令和 NODE_PATH：转接文件真的用 Git Bash / cmd 跑一遍，NODE_PATH 只在用户没设时设。

环境变量都写进测试自己的字典，不改测试进程的 os.environ。
"""

import importlib
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.plugins.test_uniwork_kits_plugin import kits, profile_env  # noqa: F401 - fixtures

windows_only = pytest.mark.skipif(os.name != "nt", reason="转接文件只在 Windows 上写")


@pytest.fixture
def terminal_env(kits):
    """按插件系统的方式导入 terminal_env，并清掉“本进程已做过”的标记。"""
    module = importlib.import_module("hermes_plugins.uniwork_kits.terminal_env")
    module._started = False
    return module


def python_folder():
    """测试用 Python 所在目录，放进 PATH 让转接文件能找到 python。"""
    return str(Path(sys.executable).parent)


@windows_only
def test_the_python3_shims_run_python_from_bash_and_cmd(terminal_env, tmp_path):
    """写出的 python3（Git Bash）和 python3.cmd（命令提示符）都能把参数原样交给 python。"""
    folder = tmp_path / "shims"
    terminal_env.write_shims(folder)
    env = {**os.environ, "PATH": os.pathsep.join([python_folder(), str(folder), os.environ.get("PATH", "")])}
    code = "import sys; print('ok', sys.argv[1])"
    cmd = subprocess.run(["cmd", "/c", "python3", "-c", code, "两 个"], capture_output=True, text=True,
                         env=env, timeout=60, encoding="utf-8", errors="replace")
    assert cmd.returncode == 0 and "ok 两 个" in cmd.stdout, cmd.stderr
    bash = shutil.which("bash")
    if bash and "system32" not in bash.lower():  # WSL 的 bash 看不到 Windows 路径，跳过
        script = f'export PATH="$(cygpath -u "{folder}"):$(cygpath -u "{python_folder()}"):$PATH"; python3 -c "{code}" x'
        done = subprocess.run([bash, "-c", script], capture_output=True, text=True, timeout=60)
        assert done.returncode == 0 and "ok x" in done.stdout, done.stderr


def test_someone_elses_python3_file_is_never_overwritten(terminal_env, tmp_path):
    """同名文件不是本插件写的就不覆盖；本插件写过的旧版本会更新。"""
    folder = tmp_path / "shims"
    folder.mkdir()
    (folder / "python3").write_text("#!/bin/sh\nexec /opt/python3.12 \"$@\"\n", encoding="utf-8")
    (folder / "python3.cmd").write_text(f"rem {terminal_env.MARK} 旧版\r\n", encoding="utf-8")
    terminal_env.write_shims(folder)
    assert "/opt/python3.12" in (folder / "python3").read_text(encoding="utf-8")
    assert (folder / "python3.cmd").read_bytes().decode("utf-8") == terminal_env.SHIMS["python3.cmd"]


def test_the_shim_folder_goes_to_the_end_of_path_once(terminal_env, tmp_path):
    """转接目录追加在 PATH 末尾，已有的 python3 仍优先；再加一次不会重复。"""
    folder = tmp_path / "shims"
    environ = {"PATH": os.pathsep.join(["C:\\first", "C:\\second"])}
    terminal_env.add_to_path(folder, environ)
    terminal_env.add_to_path(folder, environ)
    assert environ["PATH"].split(os.pathsep) == ["C:\\first", "C:\\second", str(folder)]


def test_node_path_uses_npm_root_and_falls_back_to_the_default_folder(terminal_env, tmp_path, monkeypatch):
    """NODE_PATH 取 npm root -g 的结果；npm 不在或失败时用 %APPDATA%\\npm\\node_modules；用户设过的不动。"""
    monkeypatch.setattr(terminal_env.shutil, "which", lambda name, path=None: "C:/node/npm.cmd")
    answer = "D:\\npm-global\\node_modules\n"
    environ = {"PATH": "", "APPDATA": "C:\\Users\\me\\AppData\\Roaming"}
    terminal_env.set_node_path(environ, run=lambda *a, **k: SimpleNamespace(returncode=0, stdout=answer))
    assert environ["NODE_PATH"] == "D:\\npm-global\\node_modules"

    def broken(*args, **kwargs):
        """npm 跑不起来。"""
        raise OSError("npm missing")

    environ = {"PATH": "", "APPDATA": "C:\\Users\\me\\AppData\\Roaming"}
    terminal_env.set_node_path(environ, run=broken)
    assert environ["NODE_PATH"] == str(Path("C:\\Users\\me\\AppData\\Roaming") / "npm" / "node_modules")

    environ = {"PATH": "", "NODE_PATH": "E:\\mine", "APPDATA": "C:\\x"}
    terminal_env.set_node_path(environ, run=lambda *a, **k: pytest.fail("用户设过就不该再问 npm"))
    assert environ["NODE_PATH"] == "E:\\mine"


@windows_only
def test_setup_runs_once_per_process_under_the_default_profile(terminal_env, profile_env, monkeypatch):
    """专家档案也把转接文件放在默认档案下；同一进程只做一次。"""
    monkeypatch.setattr(terminal_env, "set_node_path", lambda environ: environ.setdefault("NODE_PATH", "N"))
    expert_home = profile_env / "profiles" / "fund-diagnostician"
    expert_home.mkdir(parents=True)
    environ = {"PATH": "C:\\first"}
    assert terminal_env.setup(expert_home, environ, background=False)
    folder = profile_env / terminal_env.SHIM_DIR
    assert (folder / "python3").is_file() and (folder / "python3.cmd").is_file()
    assert environ == {"PATH": os.pathsep.join(["C:\\first", str(folder)]), "NODE_PATH": "N"}
    assert not terminal_env.setup(profile_env, {"PATH": ""}, background=False)
