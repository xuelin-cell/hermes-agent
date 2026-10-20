"""Native Windows gateway startup with the desktop's actual CLI and account cwd."""

import asyncio
import json
from pathlib import Path
import subprocess
import sys

import psutil
import pytest

from tests.apps.desktop.test_uniagentgate import gateway, install, until  # noqa: F401


async def reap_child(child):
    """回收本测试创建的 venv launcher/worker 整棵子树，不按命令行猜测进程。"""
    try:
        descendants = psutil.Process(child.pid).children(recursive=True)
    except psutil.NoSuchProcess:
        descendants = []
    for process in reversed(descendants):
        try:
            process.terminate()
        except psutil.NoSuchProcess:
            continue
    _, remaining = await asyncio.to_thread(psutil.wait_procs, descendants, timeout=5)
    for process in remaining:
        try:
            process.kill()
        except psutil.NoSuchProcess:
            continue
    if child.returncode is None:
        child.terminate()
    await asyncio.wait_for(child.wait(), 10)


@pytest.mark.platforms("windows")
# 刻意验证真实 CLI：Home、用户根、锁和工作区全部隔离；finally 回收自己创建的进程。
@pytest.mark.live_system_guard_bypass
@pytest.mark.asyncio
async def test_account_cli_starts_registered_plugin_without_taking_over_another_gateway(tmp_path, gateway):
    from gateway.status import get_running_pid
    from hermes_cli._subprocess_compat import windows_detach_flags_without_breakaway
    from tools.environments.local import served_profile_child_env

    fake, url = gateway
    home, workspace = tmp_path / "home", tmp_path / "workspace"
    workspace.mkdir()
    fake.expected["agent-native"] = "secret-native"
    install(home, url, "agent-native", "secret-native")
    config = json.loads((home / "config.yaml").read_text())
    config["model"] = {"provider": "openai", "default": "fixture-model", "base_url": f"{url}/v1"}
    config["gateway"] = {"multiplex_profiles": False}
    (home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
    with (home / ".env").open("a", encoding="utf-8") as env_file:
        env_file.write('OPENAI_API_KEY="fixture-model-key-never-used"\n')
    env = served_profile_child_env(target_home=home, inherit_credentials=True)
    env.update({"PYTHONPATH": str(Path(__file__).resolve().parents[3]),
                "TERMINAL_CWD": str(workspace), "HERMES_GATEWAY_DETACHED": "1",
                "HERMES_DISABLE_LAZY_INSTALLS": "1", "HERMES_GATEWAY_LOCK_DIR": str(home / "gateway-locks"),
                "HOME": str(tmp_path), "USERPROFILE": str(tmp_path)})
    with (tmp_path / "gateway-launch.log").open("wb") as output:
        child = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "hermes_cli.main", "gateway", "run", cwd=workspace, env=env,
            stdin=subprocess.DEVNULL, stdout=output, stderr=output,
            creationflags=windows_detach_flags_without_breakaway())
        try:
            await until(lambda: "agent-native" in fake.connected or child.returncode is not None, timeout=45)
            assert child.returncode is None, (tmp_path / "gateway-launch.log").read_text(encoding="utf-8", errors="replace")[-3000:]
            owner = get_running_pid(home / "gateway.pid", cleanup_stale=False)
            assert owner is not None
            # The same account's second ordinary `gateway run` must refuse; it cannot steal the WS.
            duplicate = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "hermes_cli.main", "gateway", "run", cwd=workspace, env=env,
                stdin=subprocess.DEVNULL, stdout=output, stderr=output, creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                await asyncio.wait_for(duplicate.wait(), 20)
            finally:
                await reap_child(duplicate)
            assert fake.registered == ["agent-native"]
            assert get_running_pid(home / "gateway.pid", cleanup_stale=False) == owner
            assert child.returncode is None
        finally:
            await reap_child(child)
