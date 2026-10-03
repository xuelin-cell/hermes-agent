"""桌面退出的一次性网关适配；不启动服务，不修改 Hermes 核心。"""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

import psutil

from gateway import status
from hermes_constants import PROFILE_ID_RE, named_profile_has_identity


def account_homes(root):
    """只枚举当前账号的真实 Profile；链接到账号外的目录拒绝处理。"""
    homes = [root]
    profiles = root / "profiles"
    if profiles.exists():
        for entry in profiles.iterdir():
            if entry.is_dir() and PROFILE_ID_RE.fullmatch(entry.name) and named_profile_has_identity(entry):
                if entry.resolve().parent != profiles.resolve() or profiles.resolve().parent != root:
                    raise RuntimeError("Profile 路径超出当前账号")
                homes.append(entry.resolve())
    return homes


def discover(homes):
    """复用原版命令身份规则，并要求实际进程环境指向当前账号 Home。"""
    rows = []
    claimed = set()
    for home in homes:
        pidfile = home / "gateway.pid"
        if pidfile.exists():
            try:
                record = json.loads(pidfile.read_text(encoding="utf-8"))
                if isinstance(record, dict) and record.get("hermes_home") == str(home):
                    claimed.add(record.get("pid"))
            except (ValueError, OSError):
                raise RuntimeError("无法读取账号网关归属") from None
    for process in psutil.process_iter():
        try:
            command = subprocess.list2cmdline(process.cmdline())
            if status.gateway_spawn_intent_subcommand(command) not in {"run", "start", "restart"}:
                continue
            env_home = process.environ().get("HERMES_HOME")
            if not env_home:
                if process.pid in claimed:
                    raise RuntimeError("账号网关缺少 Home 归属")
                continue
            home = Path(env_home).resolve()
            profile = status.profile_flag_value(command)
            if home == homes[0] and profile and profile != "default":
                home = (home / "profiles" / profile).resolve()
            if home not in homes:
                continue
            rows.append({"pid": process.pid, "created": process.create_time(), "home": str(home),
                         "launcher": not status.looks_like_gateway_runtime_command_line(command),
                         "external": "--external-supervisor" in process.cmdline()})
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            if process.pid in claimed:
                raise RuntimeError("无法复核账号网关进程") from None
    return rows


def owned_launchers(homes):
    """只信任原版生成且明确写入该 Home 的自动启动脚本。"""
    scripts = {}
    for home in homes:
        for script in (home / "gateway-service").glob("Hermes_Gateway*.vbs"):
            if script.resolve().parent != home / "gateway-service":
                raise RuntimeError("网关启动脚本越界")
            text = script.read_text(encoding="utf-8-sig")
            binding = re.search(r'^env\.Item\("HERMES_HOME"\) = "((?:[^"]|"")*)"\s*$', text, re.M)
            if binding and Path(binding[1].replace('""', '"')).resolve() == home:
                scripts[str(script.resolve()).casefold()] = str(home)
    return scripts


def pause_autostart(homes, finish=False):
    """按任务动作路径禁用自动拉起；启动文件移入账号内，保留可恢复副本。"""
    scripts = owned_launchers(homes)
    env = {**os.environ, "HERMES_MT_GATEWAY_SCRIPTS": json.dumps(scripts),
           "HERMES_MT_GATEWAY_FINISH": "1" if finish else "0"}
    command = r'''
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$map=ConvertFrom-Json $env:HERMES_MT_GATEWAY_SCRIPTS
$service=New-Object -ComObject Schedule.Service
$service.Connect()
$owned=@()
foreach ($task in $service.GetFolder('\').GetTasks(1)) {
  if ($task.Name -notlike 'Hermes_Gateway*' -or $task.Definition.Actions.Count -ne 1) {continue}
  $action=$task.Definition.Actions.Item(1)
  if ($action.Type -ne 0 -or [IO.Path]::GetFileName($action.Path) -ne 'wscript.exe') {continue}
  if ($action.Arguments -notmatch '^//B //Nologo "([^"]+)"$') {continue}
  $key=[IO.Path]::GetFullPath($Matches[1]).ToLowerInvariant()
  $property=$map.PSObject.Properties[$key]
  if (-not $property) {continue}
  $task.Enabled=$false
  if ($task.Enabled) {throw '网关自动启动任务未停用'}
  if ($env:HERMES_MT_GATEWAY_FINISH -eq '1') {$task.Stop(0)}
  $owned += [string]$property.Value
}
ConvertTo-Json -Compress -InputObject @($owned)
'''
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                            env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
                            timeout=15, creationflags=subprocess.CREATE_NO_WINDOW, check=True)
    json.loads(result.stdout)
    startup = Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs/Startup"
    for entry in startup.glob("Hermes_Gateway*.vbs"):
        text = entry.read_text(encoding="utf-8-sig")
        target = re.search(r'^target = "((?:[^"]|"")*)"\s*$', text, re.M)
        key = str(Path(target[1].replace('""', '"')).resolve()).casefold() if target else ""
        if key not in scripts:
            continue
        destination = Path(scripts[key]) / "gateway-service" / "disabled-autostart"
        destination.mkdir(exist_ok=True)
        if destination.resolve().parent != Path(scripts[key]) / "gateway-service":
            raise RuntimeError("网关自动启动备份目录越界")
        entry.rename(destination / f"{entry.name}-{uuid.uuid4().hex}.disabled")


def still_same(row):
    """PID 重用不算原网关存活，无法读取创建时间则拒绝放行。"""
    try:
        return abs(psutil.Process(row["pid"]).create_time() - row["created"]) < 0.001
    except psutil.NoSuchProcess:
        return False


def force_stop(row):
    """强停前重新核对进程创建时间，使用原版带身份防护的终止函数。"""
    if still_same(row):
        try:
            status.terminate_pid(row["pid"], force=True, expected_start_time=int(round(row["created"] * 100)))
        except (ProcessLookupError, psutil.NoSuchProcess):
            pass


def stop_gateways(homes, saved):
    """先取消拉起来源，再并行请求原版计划停止；超时后仅处理可信进程。"""
    current = discover(homes)
    for row in current:
        if row["external"]:
            raise RuntimeError("账号网关有未识别的外部监督器")
    pause_autostart(homes)
    rows = { (row["pid"], row["created"]): row for row in [*saved, *current] }
    for row in rows.values():
        if row["launcher"]:
            force_stop(row)
    for home in homes:
        runtime = [row for row in rows.values() if row["home"] == str(home)
                   and not row["launcher"] and still_same(row)]
        if not runtime:
            continue
        # Windows venv 启动器与真正 Python 可能同名同参数；只向原版确认的网关写标记。
        record = json.loads((home / "gateway.pid").read_text(encoding="utf-8"))
        if Path(record["hermes_home"]).resolve() != home:
            raise RuntimeError("网关 PID 记录归属不符")
        target = status._live_pid_from_record(record)
        row = next((item for item in runtime if item["pid"] == target), None)
        if row is None or record.get("start_time") != int(round(row["created"] * 100)):
            raise RuntimeError("网关尚未发布可信运行身份")
        marker = home / status._PLANNED_STOP_MARKER_FILENAME
        if not status._write_marker(marker, {"target_pid": row["pid"],
                "target_start_time": int(round(row["created"] * 100)), "stopper_pid": os.getpid(),
                "written_at": status._utc_now_iso()}):
            raise RuntimeError("无法写入网关计划停止标记")
    deadline = time.monotonic() + 30
    while any(still_same(row) for row in rows.values()) and time.monotonic() < deadline:
        time.sleep(0.2)
    for row in rows.values():
        force_stop(row)
    pause_autostart(homes, finish=True)
    verify_stopped(homes)


def verify_stopped(homes):
    """重复观察真实进程，不把一次停止请求成功当作退出成功。"""
    for _ in range(3):
        if discover(homes):
            raise RuntimeError("账号消息网关仍存活或被重新拉起")
        time.sleep(0.5)


def main():
    """仅接受主进程固定账号上下文；错误不输出命令行、配置或凭据。"""
    if sys.platform != "win32":
        raise RuntimeError("网关退出仅支持 Windows")
    root = Path(os.environ["HERMES_HOME"]).resolve()
    homes = account_homes(root)
    operation = sys.argv[1]
    if operation == "snapshot":
        print(json.dumps(discover(homes)))
    elif operation == "stop":
        saved = json.load(sys.stdin)
        if any(Path(row["home"]).resolve() not in homes for row in saved):
            raise RuntimeError("网关停止证据超出当前账号")
        stop_gateways(homes, saved)
        print("[]")
    elif operation == "check":
        verify_stopped(homes)
        print("[]")
    else:
        raise RuntimeError("无效网关退出操作")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("无法完成当前账号消息网关停止验证。", file=sys.stderr)
        sys.exit(1)
