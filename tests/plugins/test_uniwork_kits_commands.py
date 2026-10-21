"""套件里的斜杠命令转成技能：正文完整保留，按旧写法装过的包会被内置安装重装一次。

旧写法遇到正文里的 ``---`` 分隔线，只留下它后面的内容（ppt-writer 的 create-ppt 丢了全部步骤）。
包通过真实安装器装进临时 HERMES_HOME，内置安装走真实的 seed。
"""

import importlib
import json

from tests.plugins.test_uniwork_kits_plugin import (  # noqa: F401 - fixtures
    _skill_md,
    _write,
    _zip_dir,
    kit_pkg,
    kits,
    profile_env,
)

FLOW = "---\ndescription: 演示流程\n---\n# 步骤\n先做 A。\n\n---\n\n再做 B。\n"


def _seed():
    """按插件系统导入后的模块名取 seed。"""
    return importlib.import_module("hermes_plugins.uniwork_kits.seed")


def test_a_command_body_with_a_rule_line_keeps_what_comes_before_it(kits, profile_env, kit_pkg):
    """命令正文中间有 --- 分隔线时，装出来的技能前后两段都在。"""
    _write(kit_pkg / "commands" / "flow-probe.md", FLOW)

    receipt = kits.installer.install(kit_pkg, profile_env, triggers={}, generate_triggers=False)

    assert receipt.ok, receipt.render()
    body = _skill_md(profile_env, "demo-kit", "flow-probe")
    assert "先做 A。" in body and "再做 B。" in body


def test_a_kit_converted_the_old_way_is_reinstalled_once_by_the_bundled_install(kits, profile_env, kit_pkg, tmp_path):
    """内置包字节没变，但命令是按旧写法转换的：seed 重装一次补回来；没有命令的包照旧跳过。"""
    seed = _seed()
    plain = tmp_path / "pkgs" / "plain-kit"
    _write(plain / "plugin.json", json.dumps({"name": "plain-kit", "version": "1.0.0", "description": "没有命令的套件"},
                                             ensure_ascii=False))
    _write(plain / "SKILL.md", "---\nname: plain-kit\ndescription: 单技能\n---\n正文\n")
    directory = tmp_path / "bundle"
    _zip_dir(kit_pkg, directory / "demo-kit.zip")
    _zip_dir(plain, directory / "plain-kit.zip")
    seed.seed(profile_env, directory, generate_triggers=False)

    # 旧版本装的记录里没有 command_format。
    index = kits.store.load_index(profile_env)
    for entry in index["plugins"].values():
        entry.pop("command_format", None)
    kits.store.save_index(profile_env, index)

    first = {item.name: item.status for item in seed.seed(profile_env, directory, generate_triggers=False)}
    assert first == {"demo-kit": "installed", "plain-kit": "unchanged"}
    entry = kits.store.load_index(profile_env)["plugins"]["demo-kit"]
    assert entry["command_format"] == kits.installer.COMMAND_FORMAT

    again = {item.name: item.status for item in seed.seed(profile_env, directory, generate_triggers=False)}
    assert again == {"demo-kit": "unchanged", "plain-kit": "unchanged"}
