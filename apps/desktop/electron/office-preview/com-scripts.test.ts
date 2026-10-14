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
  public static int Pid(long h){return 123;}
  // 夹具不创建任何真实窗口。
  public static bool Visible(int pid){return false;}
}'
# 防止正式脚本重复注册受控类型。
function Add-Type {param($TypeDefinition)}
$global:quitCount=0; $global:closedCount=0; $global:securityAtOpen=0; $global:openArgs=@()
$global:window=[pscustomobject]@{Hwnd=123;Visible=$true}
$windows=[pscustomobject]@{Count=1}
$windows|Add-Member ScriptMethod Item {return $global:window}
$global:collection=[pscustomobject]@{Count=[int]$env:OTHER_DOCUMENTS}
$global:sheet=[pscustomobject]@{PageSetup=[pscustomobject]@{Zoom=$true;FitToPagesWide=0;FitToPagesTall=0}}
$global:documentModel=[pscustomobject]@{Windows=$windows;Worksheets=@($global:sheet)}
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
$global:collection|Add-Member ScriptMethod Add {$global:collection.Count++; return $global:documentModel}
$appWindows=[pscustomobject]@{Count=[int]$env:WINDOW_COUNT}
$appWindows|Add-Member ScriptMethod Item {return $global:window}
$global:officeModel=[pscustomobject]@{AutomationSecurity=1;DisplayAlerts=2;Hwnd=123;Windows=$appWindows;Documents=$global:collection;Presentations=$global:collection;Workbooks=$global:collection}
$global:officeModel|Add-Member ScriptMethod Quit {$global:quitCount++}
# 只返回受控对象，不激活真实 COM。
function New-Object {param($ComObject); return $global:officeModel}
# 返回夹具身份，不查询或结束用户进程。
function Get-Process {param($Name,$Id)
  if ($Name) {if ($env:CREATED -eq '0') {return [pscustomobject]@{Id=123}}; return}
  return [pscustomobject]@{Id=123;Path=$env:OFFICE_PROGRAM;StartTime=[DateTime]::UtcNow.AddSeconds(1)}
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
    expect(result.model.quit).toBe(1)
  })

  it('closes only its own document and restores settings after export failure', async () => {
    const result = await modelRun('word', false, true)
    expect(result.report.ok).toBe(false)
    expect(result.model.documents).toBe(2)
    expect(result.model.quit).toBe(0)
    expect(result.model.security).toBe(1)
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
  }, 15000)
})

/** 执行正式脚本与受控 COM 对象，核对的是运行行为，不读取或匹配产品源码。 */
async function modelRun(kind: OfficeDocumentKind, created: boolean, exportFail = false) {
  const script = path.join(fixture, 'model.ps1')

  const summary = String.raw`
@{securityAtOpen=$global:securityAtOpen;security=$global:officeModel.AutomationSecurity;alerts=$global:officeModel.DisplayAlerts;documents=$global:collection.Count;quit=$global:quitCount;closed=$global:closedCount;args=@($global:openArgs|ForEach-Object {if ($_ -is [System.Reflection.Missing]) {'missing'} else {$_}});page=$global:sheet.PageSetup;errors=@($Error|ForEach-Object {$_.Exception.Message})}|ConvertTo-Json -Compress -Depth 4
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
        OFFICE_SOURCE: path.join(fixture, 'sample.docx'),
        OFFICE_PDF: path.join(fixture, 'doc.pdf'),
        OFFICE_OWNER: path.join(fixture, 'owner.json'),
        OTHER_DOCUMENTS: created ? '0' : '2',
        CREATED: created ? '1' : '0',
        WINDOW_COUNT: created ? '0' : '1',
        EXPORT_FAIL: exportFail ? '1' : '0'
      }
    }
  )

  expect(result.failure).toBeUndefined()
  const lines = result.stdout.trim().split(/\r?\n/)

  return { report: JSON.parse(lines.at(-2)!), model: JSON.parse(lines.at(-1)!) }
}
