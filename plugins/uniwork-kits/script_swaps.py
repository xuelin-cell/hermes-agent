"""套件里个别脚本依赖本机没有的外部程序，装好后换成 host_scripts/ 里不依赖它的同名脚本。

目前只有一个：pdf 套件的 convert_pdf_to_images.py 用 pdf2image，它要调 poppler 的
pdftoppm。Hermes 不打包 poppler（GPL 许可，三个平台各一套，只为这一个脚本）；替换版改用
pypdfium2（pdfplumber 的依赖，脚本环境里已经有），参数、输出文件名和缩放规则不变，
forms.md 里的用法照旧。

只换内容和已知原文逐字节相同的文件：包作者以后自己改了这个脚本，就不再替换。装包时换一次；
后端启动时再检查一遍已经装好的，以前装过、包没变（seed 不会重装）的账号也能换上。
"""

from __future__ import annotations

import hashlib
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import List

from . import store

HOST_DIR = Path(__file__).with_name("host_scripts")


@dataclass(frozen=True)
class Swap:
    plugin: str
    path: str  # 相对套件目录 skills/kits/<包>/ 的路径
    original_sha256: str
    replacement: str  # host_scripts/ 下的文件名
    note: str


SWAPS = (
    Swap(
        plugin="pdf",
        path="skills/pdf/scripts/convert_pdf_to_images.py",
        original_sha256="7f58e292a67e18a8ff000d30bad2469389546731f7e8a698cc1d0aed001ea15d",
        replacement="convert_pdf_to_images.py",
        note="convert_pdf_to_images.py 改用 pypdfium2 把 PDF 转成图片（本机没有 poppler）",
    ),
)


def apply(home: Path, plugin: str) -> List[str]:
    """把这个包已装好、仍是原文的脚本换成宿主版，返回换了哪些的说明。"""
    notes: List[str] = []
    for swap in SWAPS:
        if swap.plugin != plugin:
            continue
        target = store.kit_root(home, plugin) / swap.path
        if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != swap.original_sha256:
            continue
        shutil.copyfile(HOST_DIR / swap.replacement, target)
        notes.append(swap.note)
    return notes


def apply_installed(home: Path) -> List[str]:
    """检查 home 里已装的、有替换项的包，后端启动时调用。"""
    installed = store.load_index(home).get("plugins") or {}
    return [note for plugin in sorted({swap.plugin for swap in SWAPS}) if plugin in installed
            for note in apply(home, plugin)]
