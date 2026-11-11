"""Launch a system Office converter outside PyInstaller's Python/DLL environment."""

from __future__ import annotations

import base64
import asyncio
import os
import subprocess
import sys
import zipfile
from pathlib import Path


def preview_source(source: str, output_dir: str) -> str:
    """Repackage only Tencent PPT preview copies for system ZIP-reader compatibility.

    Some native archives are readable by the SDK/Python but rejected by
    LibreOffice. All OOXML member bytes remain identical; the delivered file
    and supplier binaries are never rewritten.
    """
    path = Path(source)
    if path.suffix.lower() != ".pptx":
        return source
    with zipfile.ZipFile(path) as archive:
        if "docProps/app.xml" not in archive.namelist() or b"Tencent office" not in archive.read("docProps/app.xml"):
            return source
        target = Path(output_dir) / ".preview-source" / path.name
        target.parent.mkdir(exist_ok=True)
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as copy:
            for member in archive.infolist():
                if not member.is_dir():
                    copy.writestr(member.filename, archive.read(member))
    return str(target)


def converter_process(command: list[str]) -> tuple[list[str], dict[str, str]]:
    """Return a child-only clean environment and, on frozen Windows, a DLL-reset launcher.

    Resetting SetDllDirectory in a separate PowerShell process avoids changing
    the backend's global DLL search path while other tasks are running.
    """
    env = {key: value for key, value in os.environ.items()
           if key.upper() not in {"PYTHONHOME", "PYTHONPATH", "PYTHONEXECUTABLE", "__PYVENV_LAUNCHER__"}}
    frozen = getattr(sys, "frozen", False)
    if not frozen:
        return command, env
    bundle = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)).resolve()
    for key in ("PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"):
        if key + "_ORIG" in env:
            env[key] = env.pop(key + "_ORIG")
        elif key in env:
            env[key] = os.pathsep.join(part for part in env[key].split(os.pathsep)
                                       if part and not Path(part).resolve().is_relative_to(bundle))
    if sys.platform != "win32":
        return command, env
    def quote(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"
    script = '''$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ConverterDllPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool SetDllDirectory(string path); }'
if (-not [ConverterDllPath]::SetDllDirectory($null)) { throw 'Cannot reset converter DLL search path' }
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.UseShellExecute=$false
$start.CreateNoWindow=$true
$start.RedirectStandardOutput=$true
$start.RedirectStandardError=$true
''' + f"$start.FileName={quote(command[0])}\n$start.Arguments={quote(subprocess.list2cmdline(command[1:]))}\n" + '''
$child=[System.Diagnostics.Process]::Start($start)
$stdout=$child.StandardOutput.ReadToEndAsync()
$stderr=$child.StandardError.ReadToEndAsync()
$child.WaitForExit()
[Console]::Out.Write($stdout.Result)
[Console]::Error.Write($stderr.Result)
exit $child.ExitCode
'''
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    powershell = Path(env.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    return [str(powershell), "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], env


async def stop_converter(process: asyncio.subprocess.Process) -> None:
    """Stop only this conversion tree, including a frozen-Windows launcher child."""
    if process.returncode is not None:
        return
    if sys.platform == "win32":
        taskkill = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/taskkill.exe"
        killer = await asyncio.create_subprocess_exec(
            str(taskkill), "/PID", str(process.pid), "/T", "/F", stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL, creationflags=0x08000000,
        )
        await killer.wait()
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    await process.wait()
