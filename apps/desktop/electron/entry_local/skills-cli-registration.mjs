import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const marker = 'UniWork desktop skills CLI'

/** 只覆盖本功能已有文件，拒绝认领同名外部程序。 */
function writeLauncher(file, content, owner = file) {
  if (fs.existsSync(file) && (!fs.existsSync(owner) || !fs.readFileSync(owner, 'utf8').includes(marker))) {
    throw new Error('目标命令文件不属于 UniWork，请先检查冲突。')
  }
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp'
  try {
    fs.writeFileSync(temporary, content, { mode: 0o700, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

/** 引用 POSIX Shell 参数，保留路径中的空格、单引号和美元符号。 */
function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

/** 开发版与安装包共用入口生成；安装包传自身可执行文件而不传源码目录。 */
export async function installSkillsCli({ executable, appPath = '', python = '', helperDirectory,
  home = os.homedir(), localAppData = process.env.LOCALAPPDATA, platform = process.platform,
  registerPath = true, zshDirectory = process.env.ZDOTDIR || home }) {
  if (!['win32', 'darwin'].includes(platform)) { throw new Error('当前 CLI 入口支持 Windows 和 macOS。') }
  const directory = platform === 'win32'
    ? path.join(localAppData || path.join(home, 'AppData/Local'), 'uniworker/bin')
    : path.join(home, '.uniworker/bin')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (platform === 'darwin') {
    if (!python || !fs.existsSync(python)) { throw new Error('当前安装缺少 Python 运行组件。') }
    const helper = path.join(directory, 'skills-cli.py')
    writeLauncher(helper, '# ' + marker + '\n' + fs.readFileSync(path.join(helperDirectory, 'skills-cli.py'), 'utf8'))
    writeLauncher(path.join(directory, 'hermes'), ['#!/bin/sh', '# ' + marker, 'unset ELECTRON_RUN_AS_NODE',
      `exec ${[python, helper, executable, appPath].map(shellQuote).join(' ')} "$@"`, ''
    ].join('\n'))
    if (registerPath) {
      const line = `# ${marker} PATH\nexport PATH=${shellQuote(directory)}:"$PATH"`
      const profiles = [path.join(zshDirectory, '.zshrc'), path.join(home, '.bash_profile'), path.join(home, '.bashrc')]
      for (const file of profiles) {
        const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
        const next = previous.replace(/# UniWork desktop skills CLI PATH\r?\nexport PATH=[^\r\n]*\r?\n?/g, '')
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        fs.writeFileSync(file, next.replace(/\n*$/, '') + '\n' + line + '\n', { mode: 0o600 })
      }
    }
    return directory
  }
  const scriptPath = path.join(directory, 'skills-cli.ps1')
  const preamble = `$cliElectron = '${executable.replaceAll("'", "''")}'\r\n$cliDesktop = '${appPath.replaceAll("'", "''")}'\r\n`
  writeLauncher(scriptPath, '\ufeff# ' + marker + '\r\n' + preamble + fs.readFileSync(path.join(helperDirectory, 'skills-cli.ps1'), 'utf8'), path.join(directory, 'hermes.cmd'))
  writeLauncher(path.join(directory, 'hermes.cmd'), ['@echo off', 'rem ' + marker,
    'setlocal DisableDelayedExpansion', 'set ELECTRON_RUN_AS_NODE=',
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath.replaceAll('%', '%%')}" %*`,
    'exit /b %errorlevel%', ''
  ].join('\r\n'))
  writeLauncher(path.join(directory, 'hermes'), ['#!/bin/sh', '# ' + marker, 'unset ELECTRON_RUN_AS_NODE',
    `exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${shellQuote(scriptPath)} "$@"`, ''
  ].join('\n'))
  if (registerPath) {
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
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 })
  }
  return directory
}
