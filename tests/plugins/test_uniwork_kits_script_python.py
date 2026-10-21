"""套件和专家的 Python 脚本用独立环境里带好依赖的解释器跑。

命令改写是纯函数，直接测；钩子测「本机终端跑套件脚本才换，别的都不动」；
真的建环境要联网、耗时一分钟，不在单元测试里做（手工实测记在提交说明里）。
"""

import importlib
from pathlib import Path

import pytest

from tests.plugins.test_uniwork_kits_plugin import kits, profile_env  # noqa: F401 - fixtures

PYTHON = "C:/Users/me/AppData/Local/hmt/abc/home/environments/kits/gen-1/venv/Scripts/python.exe"
KIT_DIR = "C:/Users/me/AppData/Local/hmt/abc/home/profiles/fund-diagnostician/skills/kits/fund-diagnostician"


@pytest.fixture
def script_python(kits):
    """按插件系统的方式导入 script_python。"""
    return importlib.import_module("hermes_plugins.uniwork_kits.script_python")


@pytest.mark.parametrize("command, expected", [
    ("python3 scripts/get_data.py --query 易方达",
     f"{PYTHON} scripts/get_data.py --query 易方达"),
    (f"cd {KIT_DIR}/skills/mx-finance-data && python scripts/get_data.py --query x",
     f"cd {KIT_DIR}/skills/mx-finance-data && {PYTHON} scripts/get_data.py --query x"),
    ("PYTHONIOENCODING=utf-8 python3 scripts/a.py; py -3 scripts/b.py",
     f"PYTHONIOENCODING=utf-8 {PYTHON} scripts/a.py; {PYTHON} scripts/b.py"),
    ("(python3.11 scripts/a.py | head)", f"({PYTHON} scripts/a.py | head)"),
])
def test_every_launcher_at_the_start_of_a_segment_is_swapped(script_python, command, expected):
    """命令每一段开头的 python / python3 / python3.11 / py -3 都换掉，参数和其余部分原样保留。"""
    assert script_python.rewrite_command(command, PYTHON) == expected


def test_arguments_that_merely_mention_python_are_left_alone(script_python):
    """只换解释器那一个词：pip、参数里的 python 字样、已经写了绝对路径的解释器都不动。"""
    assert script_python.rewrite_command("pip install python-docx", PYTHON) is None
    assert script_python.rewrite_command("echo python3 is here", PYTHON) is None
    assert script_python.rewrite_command("C:/Python311/python.exe scripts/a.py", PYTHON) is None


def test_a_path_with_spaces_is_quoted_for_bash(script_python):
    """用户名带空格时解释器路径加引号，Git Bash 才能当成一个词。"""
    spaced = "C:/Users/Li Lei/env/python.exe"
    assert script_python.rewrite_command("python3 a.py", spaced) == f"'{spaced}' a.py"


def test_only_kit_and_expert_scripts_count(script_python):
    """命令或终端当前目录在 skills/kits、imported-plugins 下才算在跑套件脚本；用户自己的项目不算。"""
    assert script_python.runs_kit_script(f"python3 {KIT_DIR}/skills/a/scripts/x.py", "D:/work")
    assert script_python.runs_kit_script("python3 scripts/x.py", f"{KIT_DIR}\\skills\\a")
    assert script_python.runs_kit_script("python3 x.py", "C:/h/imported-plugins/pdf/1.0.0/scripts")
    assert not script_python.runs_kit_script("python manage.py runserver", "D:/work/my-site")


def test_the_hook_swaps_the_interpreter_only_for_a_local_kit_command(script_python, monkeypatch):
    """本机终端跑套件脚本时返回改写后的命令；非本机终端、别的工具、用户项目都返回 None，不改命令。"""
    monkeypatch.setattr(script_python, "interpreter", lambda home, name=None: Path(PYTHON))
    monkeypatch.setattr(script_python, "_local_cwd", lambda task_id: KIT_DIR)
    command = "python3 scripts/get_data.py --query 易方达"

    answer = script_python.on_pre_tool_call(tool_name="terminal", args={"command": command}, task_id="t")
    assert answer == {"action": "modify", "args": {"command": f"{PYTHON} scripts/get_data.py --query 易方达"}}

    assert script_python.on_pre_tool_call(tool_name="execute_code", args={"command": command}) is None
    monkeypatch.setattr(script_python, "_local_cwd", lambda task_id: "D:/work/my-site")
    assert script_python.on_pre_tool_call(tool_name="terminal", args={"command": "python3 manage.py"}) is None
    monkeypatch.setattr(script_python, "_local_cwd", lambda task_id: None)  # Docker / SSH backend
    assert script_python.on_pre_tool_call(tool_name="terminal", args={"command": command}) is None


def test_the_command_is_kept_when_the_environment_cannot_be_built(script_python, monkeypatch):
    """环境还没建好、等也等不到时不改命令，照原样执行，不拦用户的操作。"""
    monkeypatch.setattr(script_python, "interpreter", lambda home, name=None: None)
    monkeypatch.setattr(script_python, "prepare", lambda home, **kwargs: None)
    monkeypatch.setattr(script_python, "_local_cwd", lambda task_id: KIT_DIR)
    args = {"command": "python3 scripts/get_data.py"}
    assert script_python.on_pre_tool_call(tool_name="terminal", args=args, task_id="t") is None


def test_an_expert_profile_shares_the_default_profiles_environment(script_python, profile_env):
    """专家档案的后端也用默认档案下的那一份环境，不会每个专家各建一份。"""
    expert_home = profile_env / "profiles" / "fund-diagnostician"
    expert_home.mkdir(parents=True)
    assert script_python.environment_root(expert_home) == script_python.environment_root(profile_env)
    assert script_python.environment_root(profile_env).parent == profile_env / "environments"


def test_every_script_requirement_has_an_upper_bound(script_python):
    """依赖清单每一项都写了上限（根目录 AGENTS.md 的依赖规则），并且清单不是空的。"""
    requirements = script_python.requirements()
    assert requirements
    assert all("<" in requirement for requirement in requirements), requirements


def test_a_heavy_library_is_built_only_when_its_script_first_runs(script_python, monkeypatch):
    """缠论脚本第一次跑时才建带 czsc 的专门环境；其他脚本一直用基础环境，基础环境不带 czsc。"""
    monkeypatch.setattr(script_python, "_local_cwd", lambda task_id: KIT_DIR)
    monkeypatch.setattr(script_python, "interpreter", lambda home, name=None: None)
    built = []

    def prepare(home, wait=None, name=script_python.ENV_NAME, extra=()):
        """替身：记下要建哪个环境、额外装什么。"""
        built.append((name, tuple(extra)))
        return Path(PYTHON)

    monkeypatch.setattr(script_python, "prepare", prepare)
    chan = {"command": "python3 scripts/price-action/chan_theory.py --symbol BTC-USDT"}
    assert script_python.on_pre_tool_call(tool_name="terminal", args=chan, task_id="t")["action"] == "modify"
    other = {"command": "python3 scripts/price-action/harmonic_patterns.py"}
    assert script_python.on_pre_tool_call(tool_name="terminal", args=other, task_id="t")["action"] == "modify"

    (heavy_name, heavy_extra), (base_name, base_extra) = built
    assert heavy_name != base_name == script_python.ENV_NAME and base_extra == ()
    assert any(requirement.startswith("czsc") for requirement in heavy_extra)
    assert not any(requirement.startswith("czsc") for requirement in script_python.requirements())
