"""Windows icon-environment preparation tolerates a short antivirus PE lock."""
from pathlib import Path

import pytest


@pytest.mark.platforms("windows")
def test_icon_environment_retries_uv_trampoline_resource_lock(monkeypatch, tmp_path):
    """仅重试 UV 启动器 PE 资源被短暂占用的已知 Windows 错误。"""
    from pm.package import InstallError
    from scripts.build import icon_environment

    calls = []

    def build_environment(**kwargs):
        """前两次模拟实时扫描占用，第三次返回构建解释器。"""
        calls.append(kwargs)
        if len(calls) < 3:
            raise InstallError(
                "venv",
                "Failed to update Windows PE resources: uv-trampoline-1.exe; Access denied",
            )
        return kwargs["out"] / "Scripts/python.exe"

    monkeypatch.setattr(icon_environment.pm, "build_environment", build_environment)
    monkeypatch.setattr(icon_environment.time, "sleep", lambda _seconds: None)
    source, out, cache = (tmp_path / name for name in ("source", "out", "cache"))

    assert icon_environment.prepare_icon_environment(source, out, cache) == out / "Scripts/python.exe"
    assert len(calls) == 3


@pytest.mark.platforms("windows")
def test_icon_environment_does_not_retry_other_install_failures(monkeypatch, tmp_path):
    """依赖解析等确定性错误立即返回，避免用重试掩盖真实问题。"""
    from pm.package import InstallError
    from scripts.build import icon_environment

    calls = []

    def fail(**kwargs):
        """记录调用并返回不可重试的依赖错误。"""
        calls.append(kwargs)
        raise InstallError("venv", "dependency resolution failed")

    monkeypatch.setattr(icon_environment.pm, "build_environment", fail)

    with pytest.raises(InstallError, match="dependency resolution failed"):
        icon_environment.prepare_icon_environment(tmp_path / "source", tmp_path / "out", None)
    assert len(calls) == 1
