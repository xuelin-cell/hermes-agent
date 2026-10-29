"""execute_code 写的代码能用上套件环境里的库：代码开头补一句，把套件库目录追加到 sys.path 末尾。

补的那句真的拿去执行，确认库能导入、Hermes 自带的同名库仍然优先、报错行号不变；
钩子只读已经建好的环境，用不上时一律不改代码。
"""

import importlib
import sys
import traceback
from pathlib import Path

import pytest

from tests.plugins.test_uniwork_kits_plugin import kits, profile_env  # noqa: F401 - fixtures

VERSION = sys.version_info[:2]


@pytest.fixture
def code_packages(kits):
    """按插件系统的方式导入 code_packages。"""
    return importlib.import_module("hermes_plugins.uniwork_kits.code_packages")


@pytest.fixture
def kit_env(tmp_path):
    """一个假的套件环境：pyvenv.cfg 写当前 Python 版本，库目录里放一个只有套件环境才有的模块。"""
    venv = tmp_path / "kits" / "gen-1" / "venv"
    packages = venv / "Lib" / "site-packages"
    packages.mkdir(parents=True)
    (venv / "Scripts").mkdir()
    (venv / "Scripts" / "python.exe").write_bytes(b"")
    (venv / "pyvenv.cfg").write_text(
        f"home = C:/tools/python\nversion_info = {VERSION[0]}.{VERSION[1]}.7\n", encoding="utf-8"
    )
    (packages / "uk_only_in_kits.py").write_text("WHERE = 'kits'\n", encoding="utf-8")
    return venv / "Scripts" / "python.exe", packages


def run(code):
    """执行改写后的代码，返回执行完的变量表；执行后把 sys.path 和导入记录恢复原样。"""
    saved_path, saved_modules = list(sys.path), set(sys.modules)
    scope = {}
    try:
        exec(compile(code, "<cell>", "exec"), scope)
        return scope
    finally:
        sys.path[:] = saved_path
        for name in set(sys.modules) - saved_modules:
            del sys.modules[name]


@pytest.mark.parametrize("code", [
    "import uk_only_in_kits\nresult = uk_only_in_kits.WHERE",
    "# 读一下数据\nimport uk_only_in_kits\nresult = uk_only_in_kits.WHERE",
    "\nimport uk_only_in_kits\nresult = uk_only_in_kits.WHERE",
    "from uk_only_in_kits import WHERE as result",
    "def load():\n    import uk_only_in_kits\n    return uk_only_in_kits.WHERE\nresult = load()",
])
def test_the_rewritten_code_imports_a_library_that_only_the_kit_environment_has(code_packages, kit_env, code):
    """各种开头的代码补上那一句后都能导入套件环境里的库，原来的代码一字不改地保留。"""
    _, packages = kit_env
    rewritten = code_packages.with_packages(code, packages, VERSION)
    assert all(line in rewritten for line in code.splitlines() if line)
    assert run(rewritten)["result"] == "kits"


def test_line_numbers_in_errors_stay_the_same_when_the_first_line_is_an_import(code_packages, kit_env):
    """第一行是 import、注释或空行时补的那句接在同一行，报错时的行号和模型写的一致。"""
    _, packages = kit_env
    for first in ("import json", "# 说明", ""):
        code = f"{first}\nx = 1\nraise ValueError('第三行')"
        try:
            run(code_packages.with_packages(code, packages, VERSION))
        except ValueError:
            assert traceback.extract_tb(sys.exc_info()[2])[-1].lineno == 3, first
        else:
            pytest.fail("代码应当报错")


def test_hermes_own_libraries_keep_priority(code_packages, kit_env):
    """库目录追加在 sys.path 末尾：两边都有的库仍用 Hermes 自带的那份。"""
    _, packages = kit_env
    (packages / "json.py").write_text("raise RuntimeError('不该用到套件里的 json')\n", encoding="utf-8")
    scope = run(code_packages.with_packages("import json\nresult = json.dumps(1)", packages, VERSION))
    assert scope["result"] == "1"


def test_nothing_is_added_when_the_python_version_differs(code_packages, kit_env):
    """套件环境的 Python 版本和运行代码的不一样时不加库目录，避免装错版本的编译库。"""
    _, packages = kit_env
    code = code_packages.with_packages("import sys\nresult = sys.path[:]", packages, (2, 7))
    assert str(packages) not in run(code)["result"]


def test_code_with_future_imports_or_already_rewritten_is_left_alone(code_packages, kit_env):
    """from __future__ 必须是第一句，这种代码不动；已经补过的不再补第二次。"""
    _, packages = kit_env
    assert code_packages.with_packages("from __future__ import annotations\nx = 1", packages, VERSION) is None
    once = code_packages.with_packages("x = 1", packages, VERSION)
    assert code_packages.with_packages(once, packages, VERSION) is None


def test_the_hook_only_touches_local_execute_code_with_a_built_environment(code_packages, kit_env, monkeypatch):
    """本机 execute_code 且套件环境已建好时改代码；别的工具、非本机后端、环境没建好都返回 None。"""
    python, packages = kit_env
    script_python = importlib.import_module("hermes_plugins.uniwork_kits.script_python")
    monkeypatch.setattr(script_python, "interpreter", lambda home, name=None: python)
    monkeypatch.setattr(script_python, "_local_cwd", lambda task_id: "D:/work")
    monkeypatch.setattr(script_python, "prepare", lambda *a, **k: pytest.fail("不能在钩子里建环境"))
    args = {"code": "import uk_only_in_kits\nresult = uk_only_in_kits.WHERE", "timeout": 30}

    answer = code_packages.on_pre_tool_call(tool_name="execute_code", args=args, task_id="t")
    assert answer["action"] == "modify" and answer["args"]["timeout"] == 30
    assert run(answer["args"]["code"])["result"] == "kits"

    assert code_packages.on_pre_tool_call(tool_name="terminal", args={"command": "python a.py"}) is None
    monkeypatch.setattr(script_python, "_local_cwd", lambda task_id: None)  # Docker / SSH 后端
    assert code_packages.on_pre_tool_call(tool_name="execute_code", args=args, task_id="t") is None
    monkeypatch.setattr(script_python, "_local_cwd", lambda task_id: "D:/work")
    monkeypatch.setattr(script_python, "interpreter", lambda home, name=None: None)  # 环境还没建好
    assert code_packages.on_pre_tool_call(tool_name="execute_code", args=args, task_id="t") is None


def test_the_plugin_registers_the_hook(kits, profile_env):
    """插件入口把这个钩子登记在 pre_tool_call 上（档案指向临时目录，不碰真实账号）。"""
    hooks = []

    class Context:
        """只记下钩子，其余登记照单全收。"""

        def register_hook(self, name, handler):
            """记下钩子名和处理函数。"""
            hooks.append((name, handler))

        def __getattr__(self, name):
            """其他登记方法什么也不做。"""
            return lambda *a, **k: None

    kits.root.register(Context())
    code_packages = importlib.import_module("hermes_plugins.uniwork_kits.code_packages")
    assert ("pre_tool_call", code_packages.on_pre_tool_call) in hooks
