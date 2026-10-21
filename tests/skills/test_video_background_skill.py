"""影视下载的真实进程终态必须与 Hermes 原生完成通知一致。"""

import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "skills/uniwork/video-source-search/scripts"


@pytest.mark.parametrize("code,marker,content,success", [
    (0, True, "video", True),
    (7, True, "partial", False),
    (0, False, "partial", False),
    (0, True, "", False),
])
def test_native_completion_waits_for_real_download(tmp_path, code, marker, content, success):
    """真实后台进程等待放行后才完成；非零退出和残缺文件不能交付成品。"""
    from tools.process_registry import ProcessRegistry

    ready, release = tmp_path / "ready", tmp_path / "release"
    output = tmp_path / "测试 视频.mp4"
    child = tmp_path / "child.py"
    child.write_text(
        "import sys, time\nfrom pathlib import Path\n"
        f"Path({str(ready)!r}).touch()\n"
        f"while not Path({str(release)!r}).exists(): time.sleep(.05)\n"
        f"Path({str(output)!r}).write_text({content!r})\n"
        f"Path({str(tmp_path / 'progress')!r}).write_text({'progress=end' if marker else 'progress=continue'!r})\n"
        f"sys.exit({code})\n", encoding="utf-8",
    )
    runner = tmp_path / "runner.py"
    runner.write_text(
        "import sys\n"
        f"sys.path.insert(0, {str(SCRIPTS)!r})\n"
        "from _managed import run_download\n"
        f"sys.exit(run_download([{sys.executable!r}, {str(child)!r}], out={str(output)!r}, "
        f"sidecars={dict(progress_file=str(tmp_path / 'progress'), pid_file=str(tmp_path / 'pid'), meta_file=str(tmp_path / 'meta'), log_file=str(tmp_path / 'log'))!r}, "
        "metadata={}, max_wall=20, stall_after=0))\n", encoding="utf-8",
    )
    argv = [sys.executable, str(runner)]
    command = subprocess.list2cmdline(argv) if os.name == "nt" else shlex.join(argv)
    registry = ProcessRegistry()
    session = registry.spawn_local(command=command, cwd=str(tmp_path), task_id="download-owner", use_pty=False)
    session.notify_on_complete = True
    try:
        deadline = time.monotonic() + 10
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(.05)
        assert ready.exists(), session.output_buffer
        assert not session._completion_event.is_set()
        assert registry.completion_queue.empty()
        release.touch()
        assert session._completion_event.wait(10)
        event = registry.completion_queue.get(timeout=5)
        assert event["task_id"] == "download-owner"
        assert (event["exit_code"] == 0) == success
        assert ("MEDIA:" in event["output"]) == success
        assert not (tmp_path / "pid").exists()
        if success:
            assert output.read_text() == content
            assert str(output) in event["output"]
    finally:
        release.touch()
        if not session._completion_event.is_set():
            registry.kill_process(session.id)


def test_managed_timeout_cleans_real_download(tmp_path):
    """超时终止真实子进程，不能将已有完成标记或残缺文件判为成功。"""
    import importlib.util

    sys.path.insert(0, str(SCRIPTS))
    spec = importlib.util.spec_from_file_location("managed_video", SCRIPTS / "_managed.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    output = tmp_path / "partial.mp4"
    progress = tmp_path / "progress"
    output.write_text("partial")
    progress.write_text("progress=end")
    files = dict(progress_file=str(progress), pid_file=str(tmp_path / "pid"),
                 meta_file=str(tmp_path / "meta"), log_file=str(tmp_path / "log"))
    result = module.run_download([sys.executable, "-c", "import time; time.sleep(30)"],
                                out=str(output), sidecars=files, metadata={},
                                max_wall=2, stall_after=0)
    assert result != 0
    assert not Path(files["pid_file"]).exists()
    assert json.loads(Path(files["meta_file"]).read_text())["error"]


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("code", [0, 9])
def test_run_cli_and_status_agree_on_real_exit(tmp_path, code):
    """以真实脚本命令执行受控媒体程序；完成标记不能掩盖非零退出码。"""
    fake = tmp_path / "ffmpeg-fixture"
    fake.write_text(
        f"#!{sys.executable}\n"
        "import sys\nfrom pathlib import Path\n"
        "args = sys.argv[1:]\n"
        "Path(args[-1]).write_bytes(b'video-fixture')\n"
        "Path(args[args.index('-progress') + 1]).write_text('out_time_us=1000000\\nprogress=end\\n')\n"
        f"sys.exit({code})\n", encoding="utf-8",
    )
    fake.chmod(0o755)
    env = {**os.environ, "HOME": str(tmp_path), "VSS_FFMPEG": str(fake)}
    out = tmp_path / "电影.mp4"
    command = [sys.executable, str(SCRIPTS / "download_media.py")]
    result = subprocess.run(command + ["run", "--url", "https://fixture.invalid/video.mp4",
                            "--out", str(out), "--no-resolve", "--skip-disk-check"],
                            env=env, capture_output=True, text=True, timeout=15)
    assert (result.returncode == 0) == (code == 0), result.stdout + result.stderr
    status = subprocess.run(command + ["status", "--out", str(out), "--json"],
                            env=env, capture_output=True, text=True, timeout=15)
    assert json.loads(status.stdout)["finished"] == (code == 0)
    assert ("MEDIA:" in result.stdout) == (code == 0)
