import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const desktop = path.resolve(import.meta.dirname, '..')
const require = createRequire(path.join(desktop, 'package.json'))
if (process.platform !== 'win32') { throw new Error('此入口当前用于 Windows 源码开发版。') }
const electron = require('electron')
if (!fs.existsSync(path.join(desktop, 'dist/electron-main.mjs'))) {
  throw new Error('请先完成 Electron 开发构建。')
}
const directory = path.join(process.env.LOCALAPPDATA, 'uniworker', 'bin')
const launcher = path.join(directory, 'hermes.cmd')
const marker = 'rem UniWork desktop skills CLI'
if (fs.existsSync(launcher) && !fs.readFileSync(launcher, 'utf8').includes(marker)) {
  throw new Error('目标命令文件不属于 UniWork，请先检查冲突。')
}
const bashLauncher = path.join(directory, 'hermes')
const bashMarker = '# UniWork desktop skills CLI'
if (fs.existsSync(bashLauncher) && !fs.readFileSync(bashLauncher, 'utf8').includes(bashMarker)) {
  throw new Error('目标 Shell 命令文件不属于 UniWork，请先检查冲突。')
}
fs.mkdirSync(directory, { recursive: true })
const scriptPath = path.join(directory, 'skills-cli.ps1')
const preamble = `$cliElectron = '${electron.replaceAll("'", "''")}'\r\n$cliDesktop = '${desktop.replaceAll("'", "''")}'\r\n`
fs.writeFileSync(scriptPath, '\ufeff' + preamble + fs.readFileSync(path.join(import.meta.dirname, 'skills-cli.ps1'), 'utf8'))
fs.writeFileSync(launcher, [
  '@echo off', marker, 'setlocal DisableDelayedExpansion', 'set ELECTRON_RUN_AS_NODE=',
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath.replaceAll('%', '%%')}" %*`,
  'exit /b %errorlevel%', ''
].join('\r\n'))
// Git Bash 不按 Windows PATHEXT 查找 .cmd，使用同一 PowerShell 脚本保留账号选择规则。
fs.writeFileSync(bashLauncher, [
  '#!/bin/sh', bashMarker, 'unset ELECTRON_RUN_AS_NODE',
  `exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${scriptPath.replaceAll("'", "'\\''")}' "$@"`, ''
].join('\n'), { mode: 0o700 })
// 仅将自己的固定入口放到用户 PATH 首位，保留其他安装和原注册表类型。
const encodedDirectory = Buffer.from(directory, 'utf16le').toString('base64')
const script = `
$ErrorActionPreference = 'Stop'
$entry = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedDirectory}'))
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
  $parts = @($raw.Split(';') | Where-Object { $_ -and [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ine $entry.TrimEnd('\\') })
  $key.SetValue('Path', (@($entry) + $parts) -join ';', $kind)
} finally { $key.Dispose() }
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class UniWorkPathNotify { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r); }'
$result = [UIntPtr]::Zero
[void][UniWorkPathNotify]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$result)
`
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'inherit' })
console.log(`已注册 ${launcher}。请重新打开终端，用 Get-Command hermes 检查入口。`)
