"""Profile-owned, lazy SDK process running the supplied unmodified slidep CLI."""
from __future__ import annotations

import atexit
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time

import httpx

from .tencent_ppt_bundle import REQUIRED_FILES


def runtime_root() -> Path:
    import hermes_constants
    from hermes_cli.config import load_config_readonly

    cfg = (load_config_readonly() or {}).get("uniwork_kits") or {}
    native = cfg.get("native_ppt") or {}
    configured = native.get("runtime_dir")
    if configured:
        return Path(configured).expanduser().resolve()
    # Desktop discovers staged plugins separately; the SDK ships once in the agent payload.
    return Path(hermes_constants.__file__).resolve().parent / "tencent-ppt-runtime"


def available() -> bool:
    if os.name != "nt":
        return False
    from tools.terminal_tool import _get_env_config

    if _get_env_config().get("env_type") != "local":
        return False
    root = runtime_root()
    return all((root / name).is_file() for name in REQUIRED_FILES)


class NativeRuntime:
    def __init__(self, root: Path, home: Path):
        self.root = root
        self.state = home / "native-ppt"
        # SWC validates ancestors too. Account homes under LocalAppData can inherit
        # sandbox replacement rights, so use a private, profile-keyed user-home cache.
        key = hashlib.sha256(str(home.resolve()).encode()).hexdigest()[:16]
        self.cache = Path.home() / (".hermes-ppt-native-cache-" + key)
        self.endpoint = ""
        self.process = None
        self.client = None
        self.log = None
        self.opened = {}
        self.lock = threading.RLock()

    @property
    def cli_path(self):
        return self.root / "node/node_modules/@tencent/slidep/dist/index.js"

    def environment(self):
        # The editor does not need account secrets, inherited MCP credentials or Node hooks.
        names = {"systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp", "userprofile", "localappdata", "appdata", "programdata", "programfiles", "programfiles(x86)", "commonprogramfiles", "systemdrive"}
        env = {k: v for k, v in os.environ.items() if k.lower() in names}
        env.update(TENCENT_DOCS_LOCAL_MCP=self.endpoint + "/mcp", SWC_NATIVE_BINDING_CACHE=str(self.cache))
        return env

    def secure_cache(self):
        if self.cache.exists():
            return
        self.state.mkdir(parents=True, exist_ok=True)
        script = """$ErrorActionPreference='Stop'
$path=$env:UNICLAW_NEW_PPT_CACHE
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')){
 $rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($id),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
[System.IO.Directory]::CreateDirectory($path,$acl) | Out-Null
"""
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                       env={**self.environment(), "UNICLAW_NEW_PPT_CACHE": str(self.cache)},
                       capture_output=True, check=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)

    def start(self):
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                return
            self.stop()
            if os.name != "nt":
                raise RuntimeError("原生 PPT 当前仅支持 Windows 本地执行")
            if not all((self.root / name).is_file() for name in REQUIRED_FILES):
                raise FileNotFoundError("原生 PPT 运行时不完整，请修复应用资源")
            self.secure_cache()
            self.state.mkdir(parents=True, exist_ok=True)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            self.endpoint = f"http://127.0.0.1:{port}"
            self.client = httpx.Client(trust_env=False, timeout=120)
            self.log = (self.state / "engine-process.log").open("ab")
            self.process = subprocess.Popen([
                str(self.root / "engine/editor_sdk.exe"), "--port", str(port),
                "--log_dir", str(self.state), f"--tmp_dir={self.state / 'tmp'}",
            ], cwd=self.state, env=self.environment(), stdin=subprocess.DEVNULL,
                stdout=self.log, stderr=self.log, creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                deadline = time.monotonic() + 25
                while time.monotonic() < deadline:
                    if self.process.poll() is not None:
                        raise RuntimeError(f"PPT SDK 启动失败，日志位于 {self.state}")
                    try:
                        if self.client.get(self.endpoint + "/health", timeout=1).status_code == 200:
                            return
                    except httpx.TransportError:
                        pass
                    time.sleep(0.1)
                raise TimeoutError("PPT SDK 启动超时")
            except BaseException:
                self.stop()
                raise

    def rpc(self, name, arguments):
        response = self.client.post(self.endpoint + "/mcp", json={
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        })
        response.raise_for_status()
        data = response.json()
        if "error" in data:
            raise RuntimeError(json.dumps(data["error"], ensure_ascii=False))
        result = data["result"]
        if result.get("isError"):
            raise RuntimeError(json.dumps(result, ensure_ascii=False))
        for block in result.get("content", []):
            if block.get("type") == "text":
                try:
                    decoded = json.loads(block["text"])
                except ValueError:
                    continue
                if isinstance(decoded, dict):
                    result = {**result, **decoded}
        if result.get("ok") is False:
            raise RuntimeError(json.dumps(result, ensure_ascii=False))
        return result

    def open(self, path):
        self.start()
        path = path.resolve()
        if path not in self.opened:
            self.rpc("open_file", {"file_path": str(path), "wait": True, "open_with_existing": True})
            for entry in self.rpc("get_pool_status", {})["open_editors"]:
                if Path(entry["file_path"]).resolve() == path:
                    self.opened[path] = entry["file_id"]
                    break
            else:
                raise RuntimeError(f"SDK 未登记文稿：{path}")
        return self.opened[path]

    def cli(self, args, cwd):
        self.start()
        proc = subprocess.run([str(self.root / "node/node.exe"), str(self.cli_path), *args],
                              cwd=cwd, env=self.environment(), stdin=subprocess.DEVNULL, capture_output=True, timeout=120,
                              creationflags=subprocess.CREATE_NO_WINDOW)
        text = proc.stdout.decode("utf-8", errors="replace")
        for line in reversed(text.splitlines()):
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict) and (proc.returncode == 0 or "diagnostics" in value):
                if args[0] == "create" and value.get("file_id"):
                    self.opened[Path(args[1]).resolve()] = value["file_id"]
                return value
        # These original CLI commands write their output files without JSON stdout.
        if proc.returncode == 0 and args[0] in {"inspect", "screenshot"} and "--out" in args:
            out = Path(args[args.index("--out") + 1])
            expected = out / "slides.md" if args[0] == "inspect" and out.is_dir() else out
            if expected.is_file() and expected.stat().st_size:
                return {"ok": True, "out": str(out), "file": args[1]}
        raise RuntimeError(f"slidep {args[0]} 退出码 {proc.returncode}：" + (proc.stderr.decode("utf-8", errors="replace") + "\n" + text)[-3500:])

    def release(self, path):
        key = path.resolve()
        if self.client is None:
            self.opened.pop(key, None)
            return
        # CLI previews can open instances without updating this Python cache.
        entries = [entry for entry in self.rpc("get_pool_status", {})["open_editors"]
                   if Path(entry["file_path"]).resolve() == key]
        for entry in entries:
            if self.rpc("slide_get_info", {"file_id": entry["file_id"]}).get("is_dirty"):
                raise ValueError("SDK 中有未保存修改，先 save_file 再生成候选稿")
        for entry in entries:
            self.rpc("close_file", {"file_id": entry["file_id"], "force": True})
        self.opened.pop(key, None)

    def stop(self):
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            if self.client is not None:
                self.client.close()
            if self.log is not None:
                self.log.close()
            self.process = self.client = self.log = None
            self.opened.clear()


_engines = {}
_lock = threading.Lock()


def engine():
    from hermes_constants import get_hermes_home

    home = get_hermes_home().resolve()
    key = (home, runtime_root())
    with _lock:
        if key not in _engines:
            _engines[key] = NativeRuntime(key[1], home)
        return _engines[key]


def shutdown():
    with _lock:
        for runtime in _engines.values():
            runtime.stop()
        _engines.clear()


atexit.register(shutdown)
