"""deploy.sh 拉完代码后的行尾检查：只查受版本管理的文件。

这道检查防的是检出时行尾没保住（带 CR 的脚本在部署机上跑不起来）。部署目录里还有生成的文件：
deploy.sh base 的构建日志 .base-build.log（apt、pip 的进度条带 CR）、前端产物 nginx/dist-browser/。
以前用 grep -r 扫整个部署目录，跑完 base 再跑 all 就会被构建日志拦下（10-16 在部署机上撞过）。
"""

from __future__ import annotations

from pathlib import Path

DEPLOY_SH = Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt" / "deploy.sh"


def _function(name: str) -> str:
    script = DEPLOY_SH.read_text(encoding="utf-8")
    start = script.index(f"\n{name}() {{\n")
    return script[start : script.index("\n}\n", start)]


def test_the_line_ending_check_reads_only_tracked_files() -> None:
    pull = _function("cmd_pull")
    check = next(line for line in pull.splitlines() if "$'\\r'" in line)
    assert "git ls-files -z" in check and "xargs -0 -r grep -lI" in check
    assert "grep -r" not in pull
