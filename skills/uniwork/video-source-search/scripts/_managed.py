"""让 Hermes 跟踪完整下载生命周期，子进程保持在原生后台进程树内。"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path

from _common import IS_WIN, run_hidden


def stop_child(process):
    """停止本次创建的下载进程树，超时后强制清理，避免遗留合并进程。"""
    if IS_WIN:
        run_hidden(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if not IS_WIN:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        process.wait()


def run_download(argv, *, out, sidecars, metadata, max_wall, stall_after):
    """等待真实子进程退出并验证成品；失败返回非零，成功才输出文件引用。"""
    output = Path(out).resolve()
    progress = Path(sidecars["progress_file"])
    started = time.monotonic()
    error = ""
    # 保留真实父子关系供 Hermes 原生进程树停止；独立组仅用于脚本超时清理。
    with open(sidecars["log_file"], "w", encoding="utf-8") as log:
        with subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log,
                              stderr=subprocess.STDOUT, start_new_session=not IS_WIN) as process:
            metadata = {**metadata, "pid": process.pid, "out": str(output),
                        "started": time.time(), "managed": True, **sidecars}
            try:
                Path(sidecars["pid_file"]).write_text(str(process.pid), encoding="utf-8")
                Path(sidecars["meta_file"]).write_text(
                    json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
                while process.poll() is None:
                    elapsed = time.monotonic() - started
                    if max_wall > 0 and elapsed >= max_wall:
                        error = "下载超过允许时长，已停止。"
                        break
                    age = time.time() - progress.stat().st_mtime if progress.exists() else elapsed
                    if stall_after > 0 and age >= stall_after:
                        error = "下载长时间没有进度，已停止；请检查片源或 Referer。"
                        break
                    time.sleep(0.5)
            finally:
                if process.poll() is None:
                    stop_child(process)
                Path(sidecars["pid_file"]).unlink(missing_ok=True)
            code = process.returncode
    done = progress.is_file() and "progress=end" in progress.read_text(encoding="utf-8").splitlines()
    if not error and code == 0 and (not done or not output.is_file() or output.stat().st_size == 0):
        error = "下载未完成：缺少完成标记或非空成品文件。"
    metadata.update(exited=True, exit_code=code, error=error, completed=not error and code == 0)
    Path(sidecars["meta_file"]).write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
    if not metadata["completed"]:
        print(error or f"下载失败（exit {code}），请查看 {sidecars['log_file']}。", flush=True)
        return code if code and code > 0 else 1
    media = f"`{output}`" if any(char.isspace() for char in str(output)) else str(output)
    print(f"下载完成：{output}\nMEDIA:{media}", flush=True)
    return 0
