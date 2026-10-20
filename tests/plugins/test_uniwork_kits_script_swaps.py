"""套件里依赖本机没有的外部程序的脚本，装好后换成宿主版（script_swaps）。

假包按真实 pdf 套件的目录结构造，替换项用真实的 SWAPS 条目，只把「已知原文」的指纹换成假包脚本的，
这样校验的是：安装器放脚本的位置、替换条件和替换来源都对得上。
"""

import dataclasses
import hashlib
import json

import pytest

from tests.plugins.test_uniwork_kits_autoseed import _wait, autoseed  # noqa: F401 - fixtures
from tests.plugins.test_uniwork_kits_plugin import _write, _zip_dir, kits, profile_env  # noqa: F401 - fixtures

ORIGINAL = "from pdf2image import convert_from_path\n"


def _pdf_pkg(root, script=ORIGINAL):
    """按真实 pdf 套件的结构造一个包：.codebuddy-plugin/plugin.json 加 skills/pdf/ 下的技能和脚本。"""
    _write(root / ".codebuddy-plugin" / "plugin.json",
           json.dumps({"name": "pdf", "version": "1.0.0", "description": "PDF 工具"}, ensure_ascii=False))
    _write(root / "skills" / "pdf" / "SKILL.md", "---\nname: pdf\ndescription: 处理 PDF\n---\n见 forms.md\n")
    script_path = root / "skills" / "pdf" / "scripts" / "convert_pdf_to_images.py"
    script_path.parent.mkdir(parents=True)
    # 按字节写：指纹比的是字节，文本模式在 Windows 上会把换行写成 \r\n。
    script_path.write_bytes(script.encode())
    return root


@pytest.fixture
def known_original(kits, monkeypatch):
    """把真实的 pdf 替换项的「已知原文」指纹换成假包脚本的，返回这条替换项。"""
    swap = dataclasses.replace(kits.script_swaps.SWAPS[0],
                               original_sha256=hashlib.sha256(ORIGINAL.encode()).hexdigest())
    monkeypatch.setattr(kits.script_swaps, "SWAPS", (swap,))
    return swap


def _installed_script(kits, home, swap):
    """装好后技能目录里那份脚本的内容。"""
    return (kits.store.kit_root(home, "pdf") / swap.path).read_bytes()


def test_only_the_known_original_is_swapped_when_the_kit_is_installed(kits, profile_env, tmp_path, known_original):
    """装包时，脚本和已知原文逐字节相同才换成宿主版，回执里写明；包作者改过的脚本原样保留。"""
    host = (kits.script_swaps.HOST_DIR / known_original.replacement).read_bytes()

    receipt = kits.installer.install(_pdf_pkg(tmp_path / "pkgs" / "pdf"), profile_env, triggers={},
                                     generate_triggers=False)
    assert receipt.ok, receipt.render()
    assert _installed_script(kits, profile_env, known_original) == host
    assert known_original.note in receipt.rewrites

    edited = "from pdf2image import convert_from_path  # 作者自己改过\n"
    receipt = kits.installer.install(_pdf_pkg(tmp_path / "pkgs2" / "pdf", edited), profile_env, triggers={},
                                     generate_triggers=False)
    assert receipt.ok, receipt.render()
    assert _installed_script(kits, profile_env, known_original) == edited.encode()
    assert known_original.note not in receipt.rewrites


def test_an_account_that_installed_the_old_script_gets_it_swapped_at_startup(
    kits, autoseed, profile_env, tmp_path, known_original, monkeypatch,
):
    """以前装过、内置包没变的账号：seed 判定「未变化」不重装，后端启动时仍把旧脚本换掉。"""
    package = _pdf_pkg(tmp_path / "pkgs" / "pdf")
    directory = tmp_path / "bundle" / "uniwork-bundled"
    _zip_dir(package, directory / "plugins" / "pdf.zip")
    monkeypatch.setattr(kits.script_swaps, "SWAPS", ())  # 装的时候还没有这条替换
    assert kits.installer.install(directory / "plugins" / "pdf.zip", profile_env, triggers={},
                                  generate_triggers=False).ok
    assert _installed_script(kits, profile_env, known_original) == ORIGINAL.encode()

    monkeypatch.setattr(kits.script_swaps, "SWAPS", (known_original,))
    monkeypatch.setattr(autoseed, "BUNDLED_DIR", directory.parent)
    assert autoseed.start(profile_env) is True
    _wait(autoseed)

    assert autoseed.status()["unchanged"] == 1
    host = (kits.script_swaps.HOST_DIR / known_original.replacement).read_bytes()
    assert _installed_script(kits, profile_env, known_original) == host
