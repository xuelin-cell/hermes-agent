"""我们依赖的 hermes 行为。合并上游 hermes 之后跑一遍：这里红了，说明某个假设变了，
入口、转发器或垫片里对应的那处要跟着改。"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

web = pytest.importorskip("hermes_cli.web_server")
from fastapi import HTTPException  # noqa: E402

from hermes_cli.web_models import ManagedFileDelete  # noqa: E402


@pytest.fixture
def instance_layout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """照实例的布局：HERMES_HOME 在本地盘，home 下的 workspace 是指向卷的链接；
    沙箱镜像（Dockerfile.cube）把 HERMES_DASHBOARD_FILES_ROOT 设成这个链接。"""
    home = tmp_path / "opt-data"
    volume_workspace = tmp_path / "mnt-u" / "workspace"
    home.mkdir()
    volume_workspace.mkdir(parents=True)
    (home / "config.yaml").write_text("model: {}\n", encoding="utf-8")
    try:
        os.symlink(str(volume_workspace), str(home / "workspace"), target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("这台机器不允许建符号链接")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_DASHBOARD_FILES_ROOT", str(home / "workspace"))
    return home, volume_workspace.resolve()


@pytest.mark.asyncio
async def test_delete_is_confined_to_the_workspace_on_the_volume(instance_layout: tuple[Path, Path]) -> None:
    """浏览器版的「删除」调 DELETE /api/files（垫片 trashPath）。hermes 解开链接后把卷上的
    工作区当受管目录：文件树里给的就是卷上的真实路径，删得掉；工作区以外删不掉。"""
    home, workspace = instance_layout
    (workspace / "a.txt").write_text("x", encoding="utf-8")
    (workspace / "dir").mkdir()
    (workspace / "dir" / "b.txt").write_text("y", encoding="utf-8")
    (workspace / "c.txt").write_text("z", encoding="utf-8")

    await web.delete_managed_file(ManagedFileDelete(path=str(workspace / "a.txt")), None)
    assert not (workspace / "a.txt").exists()

    # 文件夹连同内容一起删（垫片总是带 recursive）。
    await web.delete_managed_file(ManagedFileDelete(path=str(workspace / "dir"), recursive=True), None)
    assert not (workspace / "dir").exists()

    # 经 home 下的链接给路径也行。
    await web.delete_managed_file(ManagedFileDelete(path=str(home / "workspace" / "c.txt")), None)
    assert not (workspace / "c.txt").exists()

    # 工作区以外（配置、对话库所在的 HERMES_HOME）一律 403，垫片据此提示「只能删除工作区里的文件」。
    with pytest.raises(HTTPException) as outside:
        await web.delete_managed_file(ManagedFileDelete(path=str(home / "config.yaml")), None)
    assert outside.value.status_code == 403
    assert (home / "config.yaml").exists()

    # 工作区根目录本身删不掉。
    with pytest.raises(HTTPException) as root:
        await web.delete_managed_file(ManagedFileDelete(path=str(workspace), recursive=True), None)
    assert root.value.status_code == 400
    assert workspace.is_dir()

    # 已经不在的路径回 404，垫片把它当成删除成功。
    with pytest.raises(HTTPException) as missing:
        await web.delete_managed_file(ManagedFileDelete(path=str(workspace / "gone.txt")), None)
    assert missing.value.status_code == 404
