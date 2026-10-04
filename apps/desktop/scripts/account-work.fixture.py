"""隔离退出验收：调用原版终端、Cron 与 MCP，不调用模型或外部平台。"""

import asyncio
import json
import os
from pathlib import Path
import shlex
import sys
import time


def cleanup(root: Path) -> None:
    """失败收尾仅结束本轮临时 Home 内的进程，复核创建时间防止 PID 重用。"""
    import psutil
    root = root.resolve(strict=True)
    assert root.parent == Path(os.environ["TEMP"]).resolve()
    assert root.name.startswith("hermes-mt-desktop-")
    owned = []
    for proc in psutil.process_iter():
        try:
            home = proc.environ().get("HERMES_HOME")
            if proc.pid != os.getpid() and home and Path(home).resolve().is_relative_to(root):
                owned.append((proc, proc.create_time()))
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    for proc, started in owned:
        try:
            if proc.create_time() == started:
                proc.kill()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs([proc for proc, _ in owned], timeout=10)


def pulse(target: Path, seconds: int = 600) -> None:
    """用连续写入证明进程在托盘期间工作、退出后停止。"""
    for index in range(seconds * 5):
        target.write_text(json.dumps({"pid": os.getpid(), "tick": index}), encoding="utf-8")
        time.sleep(0.2)


def cron_policy(root: Path) -> None:
    """真实临时任务库模拟停机跨期，调用原版调度器验证补跑与跳过。"""
    from datetime import datetime, timedelta, timezone
    from cron.jobs import create_job, update_job, get_job, get_due_jobs, load_jobs, save_jobs
    from cron.scheduler import tick

    home = Path(os.environ["HERMES_HOME"])
    scripts = home / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    output = root / "policy-fired.txt"
    script = scripts / "policy.py"
    script.write_text(f"from pathlib import Path\np=Path({str(output)!r})\nwith p.open('a') as f: f.write('run\\n')\n", encoding="utf-8")
    stale = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    recurring = create_job(None, "every 1m", script=script.name, no_agent=True, interpreter=sys.executable)
    update_job(recurring["id"], {"next_run_at": stale})
    assert not output.exists()  # 仅保存任务不执行；没有运行账号便没有 ticker。
    tick(verbose=False, sync=True)
    assert output.read_text() == "run\n"
    tick(verbose=False, sync=True)
    assert output.read_text() == "run\n"  # 积累的多次错过只补跑一次。
    assert get_job(recurring["id"]) is not None
    (home / "config.yaml").write_text("cron:\n  catch_up_missed: false\n", encoding="utf-8")
    skipped = create_job(None, "every 1m", script=script.name, no_agent=True, interpreter=sys.executable)
    update_job(skipped["id"], {"next_run_at": stale})
    assert skipped["id"] not in {job["id"] for job in get_due_jobs()}
    once = create_job(None, future, script=script.name, no_agent=True, interpreter=sys.executable)
    # 仅夹具将既有一次性任务移到已错过的时间，模拟关机前落盘的旧计划。
    jobs = load_jobs()
    for job in jobs:
        if job["id"] == once["id"]:
            job["next_run_at"] = stale
            job["schedule"] = {"kind": "once", "run_at": stale}
    save_jobs(jobs)
    assert once["id"] not in {job["id"] for job in get_due_jobs()}
    (root / "cron-policy.json").write_text(json.dumps({"defaultCatchUpOnce": True,
        "disabledCatchUpSkipped": True, "expiredOneShotSkipped": True}), encoding="utf-8")


def mcp_server(target: Path) -> None:
    """提供真实 stdio MCP 握手与工具响应，记录每次调用而不访问网络。"""
    for line in sys.stdin:
        request = json.loads(line)
        if "id" not in request:
            continue
        method = request["method"]
        result = {}
        if method == "initialize":
            result = {"protocolVersion": request["params"]["protocolVersion"],
                      "capabilities": {"tools": {}}, "serverInfo": {"name": "exit-fixture", "version": "1"}}
        elif method == "tools/list":
            result = {"tools": [{"name": "pulse", "description": "Fixture heartbeat",
                                 "inputSchema": {"type": "object", "properties": {}}}]}
        elif method == "tools/call":
            target.write_text(json.dumps({"pid": os.getpid(), "tick": time.time_ns()}), encoding="utf-8")
            result = {"content": [{"type": "text", "text": "fixture-alive"}]}
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)


async def work(root: Path) -> None:
    """在受桌面持有的 Python 子进程内运行原版三类工作。"""
    from tools.terminal_tool import terminal_tool
    from tools.mcp_tool import MCPServerTask
    from cron.jobs import create_job, update_job
    from cron.scheduler import tick
    from datetime import datetime, timedelta, timezone

    source = Path(__file__).resolve()
    home = Path(os.environ["HERMES_HOME"])
    scripts = home / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    short = scripts / "fixture-short.py"
    short.write_text(f"from pathlib import Path\nPath({str(root / 'cron-short.txt')!r}).write_text('done')\n", encoding="utf-8")
    long = scripts / "fixture-long.py"
    # 原版脚本目录校验保留；长任务使用独立脚本导入同一心跳函数。
    long.write_text(f"import runpy\nrunpy.run_path({str(source)!r})['pulse'](__import__('pathlib').Path({str(root / 'cron.json')!r}))\n", encoding="utf-8")
    for name, script in [("short", short), ("long", long)]:
        job = create_job(None, "every 1m", name=f"fixture-{name}", script=script.name,
                         no_agent=True, interpreter=sys.executable)
        update_job(job["id"], {"next_run_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()})
    command = " ".join(shlex.quote(value.replace("\\", "/")) for value in
                       [sys.executable, str(source), "pulse", str(root / "background.json")])
    server = MCPServerTask("p21-native")
    await asyncio.wait_for(server.start({"command": sys.executable,
        "args": [str(source), "mcp", str(root / "mcp.json")], "sampling": {"enabled": False},
        "elicitation": {"enabled": False}, "connect_timeout": 15}), 25)
    background = json.loads(terminal_tool(command, background=True, persist_on_release=True,
                                         task_id="p21-native", workdir=str(root)))
    (root / "background-result.json").write_text(json.dumps(background), encoding="utf-8")
    assert background.get("session_id"), background
    tick(verbose=False, sync=False)
    while True:
        result = await server.session.call_tool("pulse", {})
        assert result.content[0].text == "fixture-alive"
        await asyncio.sleep(0.2)


if __name__ == "__main__":
    mode, destination = sys.argv[1:3]
    target = Path(destination)
    if mode == "pulse":
        pulse(target)
    elif mode == "mcp":
        mcp_server(target)
    elif mode == "cleanup":
        cleanup(target)
    elif mode == "cron-policy":
        cron_policy(target)
    else:
        asyncio.run(work(target))
