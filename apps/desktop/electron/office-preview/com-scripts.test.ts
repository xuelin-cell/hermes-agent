import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { OfficeDocumentKind } from '../../../shared/src/office-preview'

import { officeComCleanupScript, officeComScript } from './com-scripts'
import { runOfficeProcess } from './run-process'

let fixture: string

const powershell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

// 真正执行生成的 PowerShell，但 COM、窗口和进程表全部用受控对象替代。
// 进程表：PROCESSES 列出已有进程（7 号是用户一小时前打开的，其余为刚出现的）；SPAWN=1 时启动 Office 会新出现 123 号。
const MODEL = String.raw`
Microsoft.PowerShell.Utility\Add-Type -TypeDefinition 'public static class PreviewWindows {
  // VISIBLE_PIDS 里的进程视为有可见窗口。
  public static bool Visible(int pid){return (","+System.Environment.GetEnvironmentVariable("VISIBLE_PIDS")+",").Contains(","+pid+",");}
}'
# 防止正式脚本重复注册受控类型。
function Add-Type {param($TypeDefinition)}
# 等待退出时不真的睡眠。
function Start-Sleep {param($Milliseconds)}
$global:killed=@(); $global:quitCount=0; $global:closedCount=0; $global:closedNames=@(); $global:securityAtOpen=0; $global:openArgs=@()
$global:processes=[Collections.ArrayList]::new()
# 登记一个受控进程；Kill 从进程表移除并记账，不触碰真实程序。
function New-ModelProcess($id) {
  $process=[pscustomobject]@{Id=[int]$id;StartTime=if ($id -eq 7) {[DateTime]::Now.AddHours(-1)} else {[DateTime]::Now.AddSeconds(1)}}
  $process|Add-Member ScriptMethod Kill {$global:killed+=$this.Id; $global:processes.Remove($this)}
  $process|Add-Member ScriptMethod WaitForExit {return $true}
  [void]$global:processes.Add($process)
}
foreach ($id in @(($env:PROCESSES -split ',')|Where-Object {$_})) {New-ModelProcess $id}
# 只返回受控进程表。
function Get-Process {param($Name,$Id,$ErrorAction)
  if ($null -ne $Id) {return @($global:processes|Where-Object {$Id -contains $_.Id})}
  return @($global:processes)
}
$global:collection=[pscustomobject]@{Count=[int]$env:OTHER_DOCUMENTS}
$global:lockedSheet=[pscustomobject]@{}
$global:lockedSheet|Add-Member ScriptProperty PageSetup {throw 'protected sheet'}
$global:worksheetModel=[pscustomobject]@{PageSetup=[pscustomobject]@{Zoom=$true;FitToPagesWide=0;FitToPagesTall=0}}
$windows=[pscustomobject]@{Count=1}
$windows|Add-Member ScriptMethod Item {return [pscustomobject]@{Visible=$true}}
$global:documentModel=[pscustomobject]@{Windows=$windows;Worksheets=@(if ($env:SHEET_LOCKED -eq '1') {$global:lockedSheet}; $global:worksheetModel)}
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
$global:officeModel=[pscustomobject]@{AutomationSecurity=1;DisplayAlerts=2;Documents=$global:collection;Presentations=$global:collection;Workbooks=$global:collection}
# 收尾脚本再次连上借用的实例时看到的文档：一份是本次副本，一份是用户自己的。
if ($env:OPEN_COPIES -eq '1') {
  $global:officeModel.Presentations=@($env:OFFICE_SOURCE,'C:\Users\someone\deck.pptx'|ForEach-Object {
    $document=[pscustomobject]@{FullName=$_}
    $document|Add-Member ScriptMethod Close {$global:closedNames+=$this.FullName}
    $document
  })
}
if ($env:SECURITY_FAIL -eq '1') {
  $global:securityValue=1
  $global:officeModel|Add-Member ScriptProperty AutomationSecurity {$global:securityValue} {if ($args[0] -eq 3) {throw 'controlled security failure'}; $global:securityValue=$args[0]} -Force
}
$global:officeModel|Add-Member ScriptMethod Quit {
  $global:quitCount++
  if ($env:QUIT_EXITS -ne '0') {$global:processes.Remove(@($global:processes|Where-Object {$_.Id -eq 123})[0])}
}
# 只返回受控对象，不激活真实 COM；SPAWN=1 时像 Word 一样新开一个进程。
function New-Object {param($ComObject)
  if ($env:SPAWN -eq '1' -and -not @($global:processes|Where-Object {$_.Id -eq 123}).Count) {New-ModelProcess 123}
  if ($env:ACTIVATION_FAIL -eq '1') {throw 'controlled activation failure'}
  return $global:officeModel
}
`

const SUMMARY = String.raw`
@{errors=@($Error|ForEach-Object {$_.Exception.Message});killed=@($global:killed);left=@($global:processes|ForEach-Object {$_.Id});securityAtOpen=$global:securityAtOpen;security=$global:officeModel.AutomationSecurity;alerts=$global:officeModel.DisplayAlerts;documents=$global:collection.Count;quit=$global:quitCount;closed=$global:closedCount;closedNames=@($global:closedNames);args=@($global:openArgs|ForEach-Object {if ($_ -is [System.Reflection.Missing]) {'missing'} else {$_}});page=$global:worksheetModel.PageSetup}|ConvertTo-Json -Compress -Depth 4
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

/** .NET 的时间刻度（100 纳秒，从公元 1 年起），与脚本记录的启动时间同一单位。 */
function ticks(ms: number) {
  return ((BigInt(ms) + 62_135_596_800_000n) * 10_000n).toString()
}

/** 执行正式脚本与受控 COM 对象，核对的是运行行为，不读取或匹配产品源码。 */
async function modelRun(script: string, env: NodeJS.ProcessEnv) {
  const file = path.join(fixture, 'model.ps1')
  await fs.writeFile(file, '\uFEFF' + MODEL + '\n' + script + '\n' + SUMMARY)

  const result = await runOfficeProcess(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    {
      cwd: fixture,
      timeoutMs: 15000,
      env: {
        ...process.env,
        OFFICE_PROGID: 'Controlled.Application',
        OFFICE_NAMES: JSON.stringify(['controlled']),
        OFFICE_SOURCE: path.join(fixture, 'source.docx'),
        OFFICE_PDF: path.join(fixture, 'doc.pdf'),
        OFFICE_OWNER: path.join(fixture, 'owner.json'),
        OTHER_DOCUMENTS: '0',
        ...env
      }
    }
  )

  expect(result.failure, result.stdout).toBeUndefined()
  const lines = result.stdout.trim().split(/\r?\n/)
  const owner = await fs.readFile(path.join(fixture, 'owner.json'), 'utf8').then(JSON.parse, () => null)

  return { report: JSON.parse(lines.at(-2)!), model: JSON.parse(lines.at(-1)!), owner }
}

/** 运行转换脚本；默认是用户开着另一个实例、本次借用它的情形。 */
function convertRun(kind: OfficeDocumentKind, env: NodeJS.ProcessEnv = {}) {
  return modelRun(officeComScript(kind), { PROCESSES: '7', ...env })
}

describe.runIf(process.platform === 'win32')('COM PowerShell behavior', { timeout: 30000 }, () => {
  it.each(['word', 'slides', 'sheet'] as const)(
    'opens %s read-only with macros disabled; in a borrowed instance closes only its own copy and changes nothing else',
    async kind => {
      const { report, model } = await convertRun(kind, { OTHER_DOCUMENTS: '2' })
      expect(report).toEqual({ ok: true, code: 'convert_failed', clean: true })
      expect(model.securityAtOpen).toBe(3)
      expect(model.security).toBe(1)
      expect(model.alerts).toBe(2)
      expect(model.documents).toBe(2)
      expect(model.closed).toBe(1)
      expect(model.quit).toBe(0)
      expect(model.killed).toEqual([])
      expect(model.left).toEqual([7])

      if (kind === 'word') {
        expect(model.args[2]).toBe(true)
        // 带一个占位密码：加密文件直接报错，不弹密码框。
        expect(model.args[4]).toMatch(/\S/)
        expect(model.args[11]).toBe(false)
      }

      if (kind === 'slides') {
        expect(model.args[1]).toBe(-1)
        expect(model.args[3]).toBe(0)
      }

      if (kind === 'sheet') {
        expect(model.args[1]).toBe(0)
        expect(model.args[2]).toBe(true)
        expect(model.args[4]).toMatch(/\S/)
        expect(model.page.FitToPagesWide).toBe(1)
      }
    }
  )

  it.each([{}, { EXPORT_FAIL: '1' }, { SECURITY_FAIL: '1' }])(
    'always quits the new instance it started, leaving the user process alone (%o)',
    async failure => {
      const { report, model, owner } = await convertRun('word', { SPAWN: '1', ...failure })
      expect(report.ok).toBe(Object.keys(failure).length === 0)
      expect(report.clean).toBe(true)
      expect(owner.pids).toEqual([123])
      expect(model.quit).toBe(1)
      expect(model.killed).toEqual([])
      expect(model.left).toEqual([7])
      expect(model.documents).toBe(0)
      expect(model.alerts).toBe(2)
    }
  )

  it('ends its own hidden instance that does not exit after quitting, but not one that shows a window', async () => {
    const hidden = await convertRun('word', { SPAWN: '1', QUIT_EXITS: '0' })
    expect(hidden.report).toMatchObject({ ok: true, clean: true })
    expect(hidden.model.killed).toEqual([123])
    expect(hidden.model.left).toEqual([7])

    const visible = await convertRun('word', { SPAWN: '1', QUIT_EXITS: '0', VISIBLE_PIDS: '123' })
    expect(visible.report).toMatchObject({ ok: true, clean: false })
    expect(visible.model.killed).toEqual([])
  })

  it('hands its instance over without quitting when someone else opened a document in it', async () => {
    const { report, model } = await convertRun('word', { SPAWN: '1', OTHER_DOCUMENTS: '1' })
    expect(report).toMatchObject({ ok: true, clean: true })
    expect(model.quit).toBe(0)
    expect(model.killed).toEqual([])
    expect(model.documents).toBe(1)
  })

  it('records the failed activation and stops the hidden process it left behind', async () => {
    const { report, model, owner } = await convertRun('word', { SPAWN: '1', ACTIVATION_FAIL: '1' })
    expect(report).toEqual({ ok: false, code: 'unavailable', clean: true })
    expect(owner.error.stage).toBe('activation')
    expect(typeof owner.error.hresult).toBe('number')
    expect(owner.error).not.toHaveProperty('message')
    expect(model.killed).toEqual([123])
    expect(model.left).toEqual([7])
  })

  it('exports a workbook even when one sheet refuses page setup changes', async () => {
    const { report, model } = await convertRun('sheet', { SHEET_LOCKED: '1' })
    expect(report.ok).toBe(true)
    expect(model.page.FitToPagesWide).toBe(1)
    expect(await fs.readFile(path.join(fixture, 'doc.pdf'), 'utf8')).toBe('%PDF-fixture')
  })

  it('after a timeout ends only the instance it started, even while a dialog is showing', async () => {
    const owner = { activated: true, pids: [123], before: [7], began: ticks(Date.now() - 60_000) }
    await fs.writeFile(path.join(fixture, 'owner.json'), JSON.stringify(owner))

    const { report, model } = await modelRun(officeComCleanupScript('word'), {
      PROCESSES: '7,123',
      VISIBLE_PIDS: '7,123'
    })

    expect(report.ok).toBe(true)
    expect(model.killed).toEqual([123])
    expect(model.left).toEqual([7])
  })

  it('after a timeout in a borrowed PowerPoint closes only its own copy and restores macro security', async () => {
    const owner = { activated: true, pids: [], before: [7], began: ticks(Date.now() - 60_000), security: 2 }
    await fs.writeFile(path.join(fixture, 'owner.json'), JSON.stringify(owner))
    const { report, model } = await modelRun(officeComCleanupScript('slides'), { PROCESSES: '7', OPEN_COPIES: '1' })
    expect(report.ok).toBe(true)
    expect(model.closedNames).toEqual([path.join(fixture, 'source.docx')])
    expect(model.security).toBe(2)
    expect(model.killed).toEqual([])
  })

  it('after a failed activation stops only hidden new processes and lets other software be tried', async () => {
    const owner = { activated: false, pids: [], before: [7], began: ticks(Date.now() - 60_000) }
    await fs.writeFile(path.join(fixture, 'owner.json'), JSON.stringify(owner))

    const { report, model } = await modelRun(officeComCleanupScript('word'), {
      PROCESSES: '7,123,124',
      VISIBLE_PIDS: '123'
    })

    expect(report.ok).toBe(true)
    expect(model.killed).toEqual([124])
    expect(model.left).toEqual([7, 123])
  })

  it('stops a real recorded process after a timeout, but not a process that only reuses its number', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true })

    const env = {
      ...process.env,
      OFFICE_NAMES: JSON.stringify([path.basename(process.execPath, '.exe')]),
      OFFICE_OWNER: path.join(fixture, 'owner.json')
    }

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(officeComCleanupScript('word'), 'utf16le').toString('base64')
    ]

    const options = { cwd: fixture, env, timeoutMs: 15000 }

    try {
      // 记录的启动时间晚于这个进程：说明编号已被别的进程重用，不能结束。
      const reused = { activated: true, pids: [child.pid], before: [], began: ticks(Date.now() + 60_000) }
      await fs.writeFile(env.OFFICE_OWNER, JSON.stringify(reused))
      expect(JSON.parse((await runOfficeProcess(powershell, args, options)).stdout).ok).toBe(true)
      expect(child.exitCode).toBeNull()

      await fs.writeFile(env.OFFICE_OWNER, JSON.stringify({ ...reused, began: ticks(Date.now() - 60_000) }))
      expect(JSON.parse((await runOfficeProcess(powershell, args, options)).stdout).ok).toBe(true)
      await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }
  }, 30000)
})
