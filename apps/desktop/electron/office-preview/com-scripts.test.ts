import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { OfficeDocumentKind } from '../../../shared/src/office-preview'

import { OFFICE_COM_CLEANUP, officeComScript } from './com-scripts'
import { runOfficeProcess } from './run-process'

let fixture: string

const powershell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

// 真正执行生成的 PowerShell，但 COM、窗口和进程查询全部用受控对象替代。
const MODEL = String.raw`
Microsoft.PowerShell.Utility\Add-Type -TypeDefinition 'public static class PreviewWindows {
  // 受控窗口固定属于夹具进程。
  public static int Pid(long h){return h==0||h==-1?0:123;}
  // 夹具不创建任何真实窗口。
  public static bool Visible(int pid){return false;}
  // 受控路径模拟原生跨位数查询，不依赖 Get-Process.Path。
  public static string ProcessPath(int pid){return System.Environment.GetEnvironmentVariable("ACTUAL_PROGRAM")??System.Environment.GetEnvironmentVariable("OFFICE_PROGRAM");}
}'
# 防止正式脚本重复注册受控类型。
function Add-Type {param($TypeDefinition)}
$global:quitCount=0; $global:closedCount=0; $global:securityAtOpen=0; $global:openArgs=@()
$global:processModel=[pscustomobject]@{Id=123;StartTime=[DateTime]::UtcNow.AddSeconds(1)}
# 模拟结束夹具进程，不触碰真实程序。
$global:processModel|Add-Member ScriptMethod Kill {$global:stoppedCount++}
# 固定夹具结束状态，供二次身份核对使用。
$global:processModel|Add-Member ScriptMethod WaitForExit {return $true}
$global:stoppedCount=0
$global:window=[pscustomobject]@{Hwnd=123;Visible=$true}
$windows=[pscustomobject]@{Count=1}
$windows|Add-Member ScriptMethod Item {
  if ($this.Count -eq 0) {throw [Runtime.InteropServices.COMException]::new('No document window',-2146822347)}
  return $global:window
}
$global:collection=[pscustomobject]@{Count=[int]$env:OTHER_DOCUMENTS}
$global:worksheetModel=[pscustomobject]@{PageSetup=[pscustomobject]@{Zoom=$true;FitToPagesWide=0;FitToPagesTall=0}}
$global:documentModel=[pscustomobject]@{Windows=$windows;Worksheets=@($global:worksheetModel)}
$global:documentModel|Add-Member ScriptMethod Close {$global:collection.Count--; $global:closedCount++}
$global:documentModel|Add-Member ScriptMethod SaveAs {
  if ($env:EXPORT_FAIL -eq '1') {throw 'controlled export failure'}
  [IO.File]::WriteAllText($args[0],'%PDF-fixture')
}
$global:documentModel|Add-Member ScriptMethod ExportAsFixedFormat {[IO.File]::WriteAllText($args[1],'%PDF-fixture')}
$global:collection|Add-Member ScriptMethod Open {
  $global:securityAtOpen=$global:officeModel.AutomationSecurity; $global:openArgs=$args
  if ($global:securityAtOpen -ne 3) {throw 'macros not disabled'}
  $global:collection.Count++; return $global:documentModel
}
$global:collection|Add-Member ScriptMethod Add {
  $global:collection.Count++
  $global:documentModel.Windows.Count=if ($args.Count -ge 4 -and -not $args[3]) {0} else {1}
  return $global:documentModel
}
$appWindows=[pscustomobject]@{Count=[int]$env:WINDOW_COUNT}
$appWindows|Add-Member ScriptMethod Item {return $global:window}
$global:officeModel=[pscustomobject]@{UserControl=$env:USER_CONTROL -eq '1';Visible=$env:APP_VISIBLE -eq '1';AutomationSecurity=1;DisplayAlerts=2;Hwnd=123;Windows=$appWindows;Documents=$global:collection;Presentations=$global:collection;Workbooks=$global:collection}
if ($env:APP_HANDLE) {$global:officeModel.Hwnd=[long]$env:APP_HANDLE}
if ($env:SECURITY_FAIL -eq '1' -or $env:RESTORE_FAIL -eq '1') {
  $global:securityValue=1
  $global:officeModel|Add-Member ScriptProperty AutomationSecurity {$global:securityValue} {if (($args[0] -eq 3 -and $env:SECURITY_FAIL -eq '1') -or ($args[0] -eq 1 -and $env:RESTORE_FAIL -eq '1')) {throw 'controlled security failure'}; $global:securityValue=$args[0]} -Force
}
$global:officeModel|Add-Member ScriptMethod Quit {$global:quitCount++}
# 只返回受控对象，不激活真实 COM。
function New-Object {param($ComObject); return $global:officeModel}
# 返回夹具身份，不查询或结束用户进程。
function Get-Process {param($Name,$Id)
  if ($Name) {if ($env:CREATED -eq '0') {return [pscustomobject]@{Id=123}}; return}
  if ($env:BIND_FAIL -eq '1') {throw 'controlled identity failure'}
  return $global:processModel
}
`

beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-com-script-'))
})
afterEach(async () => {
  const relative = path.relative(os.tmpdir(), fixture)

  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith('hermes-com-script-')) {
    throw new Error('Unsafe fixture cleanup')
  }

  await fs.rm(fixture, { recursive: true, force: true })
})

describe.runIf(process.platform === 'win32')('COM PowerShell behavior', () => {
  it.each(['word', 'slides', 'sheet'] as const)(
    'opens %s read-only with macros disabled and preserves existing documents and settings',
    async kind => {
      const result = await modelRun(kind, false)
      expect(result.report.ok, JSON.stringify(result.model.errors)).toBe(true)
      expect(result.model.securityAtOpen).toBe(3)
      expect(result.model.security).toBe(1)
      expect(result.model.alerts).toBe(2)
      expect(result.model.documents).toBe(2)
      expect(result.model.quit).toBe(0)

      if (kind === 'word') {
        expect(result.model.args[2]).toBe(true)
        expect(result.model.args[11]).toBe(false)
      }

      if (kind === 'slides') {
        expect(result.model.args[1]).toBe(-1)
        expect(result.model.args[3]).toBe(0)
      }

      if (kind === 'sheet') {
        expect(result.model.args[1]).toBe(0)
        expect(result.model.args[2]).toBe(true)
        expect(result.model.page.FitToPagesWide).toBe(1)
      }
    }
  )

  it('closes its hidden Word identity probe and quits only a new empty invisible instance', async () => {
    const result = await modelRun('word', true)
    expect(result.report.ok, JSON.stringify(result.model.errors)).toBe(true)
    expect(result.model.documents).toBe(0)
    expect(result.model.closed).toBe(2)
    expect(result.model.quit).toBe(0)
    expect(result.model.stopped).toBe(1)
    expect(result.model.visible).toBe(false)
  })

  it('does not create an identity document in a visible Word instance without document windows', async () => {
    const result = await modelRun('word', true, false, false, true)

    expect(result.report.ok).toBe(false)
    expect(result.model.closed).toBe(0)
    expect(result.model.quit).toBe(0)
    expect(result.model.documents).toBe(0)
    expect(result.model.visible).toBe(true)
    expect(result.model.security).toBe(1)
  })

  it.each([true, false])('closes only its own windowless WPS slides document (new instance: %s)', async created => {
    const result = await modelRun('slides', created, false, false, false, { APP_HANDLE: '-1', OFFICE_PROVIDER: 'wps' })
    const owner = JSON.parse(await fs.readFile(path.join(fixture, 'owner.json'), 'utf8'))

    expect(result.report.ok, JSON.stringify(result.model.errors)).toBe(true)
    expect(result.model.documents).toBe(created ? 0 : 2)
    expect(result.model.closed).toBe(1)
    expect(result.model.stopped).toBe(0)
    expect(result.model.quit).toBe(0)
    expect(owner.windowless).toBe(true)
    expect(owner.closed).toBe(true)
    expect(owner.pid).toBeUndefined()
  })

  it('closes only its own document and restores settings after export failure', async () => {
    const result = await modelRun('word', false, true)
    expect(result.report.ok).toBe(false)
    expect(result.model.documents).toBe(2)
    expect(result.model.quit).toBe(0)
    expect(result.model.security).toBe(1)
  })

  it('records the failed identity phase and quits only its standalone COM object without guessing a PID', async () => {
    const result = await modelRun('word', true, false, true)
    const owner = JSON.parse(await fs.readFile(path.join(fixture, 'owner.json'), 'utf8'))

    expect(result.report.ok).toBe(false)
    expect(owner.error.stage).toBe('identity')
    expect(typeof owner.error.type).toBe('string')
    expect(typeof owner.error.hresult).toBe('number')
    expect(owner.error).not.toHaveProperty('message')
    expect(owner.pid).toBeUndefined()
    expect(result.model.quit).toBe(1)
    expect(owner.quit).toBe(true)
    expect(result.model.documents).toBe(0)
    expect(result.model.security).toBe(1)
  })

  it('quits a standalone Word when security setup fails before any window or PID lookup', async () => {
    const result = await modelRun('word', true, false, false, false, { SECURITY_FAIL: '1' })
    const owner = JSON.parse(await fs.readFile(path.join(fixture, 'owner.json'), 'utf8'))

    expect(result.report.ok).toBe(false)
    expect(owner.error.stage).toBe('security')
    expect(owner.pid).toBeUndefined()
    expect(owner.quit).toBe(true)
    expect(result.model.quit).toBe(1)
    expect(result.model.documents).toBe(0)
  })

  it('does not quit a shared PowerPoint or a user-controlled Word after an unregistered identity failure', async () => {
    const shared = await modelRun('slides', true, false, true)
    expect(shared.report.ok).toBe(false)
    expect(shared.model.quit).toBe(0)
    const controlled = await modelRun('word', true, false, true, false, { USER_CONTROL: '1' })
    expect(controlled.report.ok).toBe(false)
    expect(controlled.model.quit).toBe(0)
  })

  it('still quits its standalone empty Word when restoring settings also fails after the identity error', async () => {
    const result = await modelRun('word', true, false, true, false, { RESTORE_FAIL: '1' })
    const owner = JSON.parse(await fs.readFile(path.join(fixture, 'owner.json'), 'utf8'))

    expect(result.report.ok).toBe(false)
    expect(owner.error.stage).toBe('identity')
    expect(owner.cleanupError).toBeDefined()
    expect(owner.closed).toBe(true)
    expect(owner.quit).toBe(true)
    expect(result.model.quit).toBe(1)
  })

  it('records a mismatched COM process before refusing conversion, without quitting the wrong application', async () => {
    const result = await modelRun('word', true, false, false, false, { ACTUAL_PROGRAM: 'C:\\Other\\other.exe' })
    const owner = JSON.parse(await fs.readFile(path.join(fixture, 'owner.json'), 'utf8'))

    expect(result.report.ok).toBe(false)
    expect(owner.pid).toBe(123)
    expect(owner.matched).toBe(false)
    expect(owner.actualExecutable).toBe('C:\\Other\\other.exe')
    expect(result.model.quit).toBe(0)
    expect(result.model.securityAtOpen).toBe(0)
  })

  it('validates creation time and leaves borrowed processes alive before stopping only its real owned hidden helper', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true })
    const env = { ...process.env, OFFICE_OWNER: path.join(fixture, 'owner.json') }
    const options = { cwd: fixture, env, timeoutMs: 10000 }

    try {
      const probe = await runOfficeProcess(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${child.pid}).StartTime.ToUniversalTime().Ticks.ToString()`
        ],
        options
      )

      expect(probe.failure).toBeUndefined()
      const started = probe.stdout.trim()

      const owner = {
        pid: child.pid,
        executable: await fs.realpath(process.execPath),
        started,
        created: false,
        matched: true,
        closed: true
      }

      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(OFFICE_COM_CLEANUP, 'utf16le').toString('base64')
      ]

      await fs.writeFile(env.OFFICE_OWNER, JSON.stringify(owner))
      expect(JSON.parse((await runOfficeProcess(powershell, args, options)).stdout).ok).toBe(true)
      expect(child.exitCode).toBeNull()
      const shell32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

      if (await fs.stat(shell32).then(() => true, () => false)) {
        expect(JSON.parse((await runOfficeProcess(shell32, args, options)).stdout).ok).toBe(true)
        expect(child.exitCode).toBeNull()
      }

      const windowless = { paths: [owner.executable], before: [child.pid], began: started, activated: true, closed: false }

      await fs.writeFile(env.OFFICE_OWNER, JSON.stringify(windowless))
      expect(JSON.parse((await runOfficeProcess(powershell, args, options)).stdout).ok).toBe(false)
      await fs.writeFile(env.OFFICE_OWNER, JSON.stringify({ ...windowless, closed: true }))
      expect(JSON.parse((await runOfficeProcess(powershell, args, options)).stdout).ok).toBe(true)
      expect(child.exitCode).toBeNull()

      await fs.writeFile(
        env.OFFICE_OWNER,
        JSON.stringify({ ...owner, created: true, started: (BigInt(started) + 1n).toString() })
      )
      expect(JSON.parse((await runOfficeProcess(powershell, args, options)).stdout).ok).toBe(false)
      expect(child.exitCode).toBeNull()
      await fs.writeFile(env.OFFICE_OWNER, JSON.stringify({ ...owner, created: true }))
      expect(JSON.parse((await runOfficeProcess(powershell, args, options)).stdout).ok).toBe(true)
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }
  }, 20000)
})

/** 执行正式脚本与受控 COM 对象，核对的是运行行为，不读取或匹配产品源码。 */
async function modelRun(kind: OfficeDocumentKind, created: boolean, exportFail = false, bindFail = false, visible = false, extraEnv: NodeJS.ProcessEnv = {}) {
  const script = path.join(fixture, 'model.ps1')

  const summary = String.raw`
@{stopped=$global:stoppedCount;visible=$global:officeModel.Visible;securityAtOpen=$global:securityAtOpen;security=$global:officeModel.AutomationSecurity;alerts=$global:officeModel.DisplayAlerts;documents=$global:collection.Count;quit=$global:quitCount;closed=$global:closedCount;args=@($global:openArgs|ForEach-Object {if ($_ -is [System.Reflection.Missing]) {'missing'} else {$_}});page=$global:worksheetModel.PageSetup;errors=@($Error|ForEach-Object {$_.Exception.Message})}|ConvertTo-Json -Compress -Depth 4
`

  await fs.writeFile(script, '\uFEFF' + MODEL + '\n' + officeComScript(kind) + '\n' + summary)

  const result = await runOfficeProcess(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    {
      cwd: fixture,
      timeoutMs: 10000,
      env: {
        ...process.env,
        OFFICE_PROGRAM: process.execPath,
        OFFICE_PROGID: 'Controlled.Application',
        OFFICE_PATHS: JSON.stringify([process.execPath]),
        OFFICE_STANDALONE: kind === 'slides' ? '0' : '1',
        OFFICE_PROVIDER: 'ms-office',
        OFFICE_SOURCE: path.join(fixture, 'sample.docx'),
        OFFICE_PDF: path.join(fixture, 'doc.pdf'),
        OFFICE_OWNER: path.join(fixture, 'owner.json'),
        OTHER_DOCUMENTS: created ? '0' : '2',
        CREATED: created ? '1' : '0',
        WINDOW_COUNT: created ? '0' : '1',
        EXPORT_FAIL: exportFail ? '1' : '0',
        BIND_FAIL: bindFail ? '1' : '0',
        APP_VISIBLE: visible ? '1' : '0',
        ...extraEnv
      }
    }
  )

  expect(result.failure).toBeUndefined()
  const lines = result.stdout.trim().split(/\r?\n/)

  return { report: JSON.parse(lines.at(-2)!), model: JSON.parse(lines.at(-1)!) }
}
