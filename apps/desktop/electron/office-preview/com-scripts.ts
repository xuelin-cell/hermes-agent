import type { OfficeDocumentKind } from '../../../shared/src/office-preview'

// 两个脚本共用：输出 UTF-8，按程序名列出进程，判断进程有没有可见窗口。不按进程名批量结束程序。
const PRELUDE = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PreviewWindows {
  // 读取窗口所属进程。
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  // 枚举顶层窗口。
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr data);
  // 读取窗口可见状态。
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  delegate bool WindowCallback(IntPtr h, IntPtr data);
  // 进程有任意可见顶层窗口时返回 true，说明用户可能正在使用它。
  public static bool Visible(int pid) {bool seen=false; EnumWindows((h,d)=>{uint p; GetWindowThreadProcessId(h,out p); seen=seen||(p==pid&&IsWindowVisible(h)); return !seen;},IntPtr.Zero); return seen;}
}
'@
$names=[string[]](ConvertFrom-Json $env:OFFICE_NAMES)
# 列出同名程序里启动时间不早于 $since 的进程；查询途中退出或无权查看的进程跳过。
function Get-Office($since) {
  @(Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object {try {$_.StartTime.ToUniversalTime().Ticks -ge $since} catch {$false}})
}
# 仅释放真实 COM 引用，不能把普通返回值当作 COM 对象释放。
function Release-OfficeObject($value) {
  if ($value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) {[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($value)}
}
`

interface ComCommands {
  collection: string
  open: string
  export: string
  close: string
  alerts: string
}

// 加密的旧格式文件用这个占位密码打开会直接报错，而不是弹出密码框卡到超时；没加密的文件会忽略它。
const NO_PASSWORD = 'hermes-preview-no-password'

const COMMANDS: Record<OfficeDocumentKind, ComCommands> = {
  word: {
    collection: 'Documents',
    alerts: '0',
    open: `$doc=$documents.Open($env:OFFICE_SOURCE,$false,$true,$false,"${NO_PASSWORD}",$missing,$false,"",$missing,$missing,$missing,$false)`,
    export: '[void]$doc.SaveAs($env:OFFICE_PDF,17)',
    close: '[void]$doc.Close($false)'
  },
  slides: {
    collection: 'Presentations',
    alerts: '1',
    open: '$doc=$documents.Open($env:OFFICE_SOURCE,-1,0,0)',
    export: '[void]$doc.SaveAs($env:OFFICE_PDF,32)',
    close: '[void]$doc.Close()'
  },
  sheet: {
    collection: 'Workbooks',
    alerts: '$false',
    open: `$doc=$documents.Open($env:OFFICE_SOURCE,0,$true,$missing,"${NO_PASSWORD}","",$true); $identityWindows=$doc.Windows; $identityWindow=$identityWindows.Item(1); $identityWindow.Visible=$false; Release-OfficeObject $identityWindow; $identityWindow=$null; Release-OfficeObject $identityWindows; $identityWindows=$null`,
    export: String.raw`
$worksheets=$doc.Worksheets
try {
  foreach ($sheet in $worksheets) {
    # 受保护或没有打印机的表改不了页面设置，保持原样继续，不让整份工作簿失败。
    try {$setup=$sheet.PageSetup; $setup.Zoom=$false; $setup.FitToPagesWide=1; $setup.FitToPagesTall=$false} catch {} finally {Release-OfficeObject $setup; $setup=$null; Release-OfficeObject $sheet; $sheet=$null}
  }
} finally {Release-OfficeObject $worksheets; $worksheets=$null}
[void]$doc.ExportAsFixedFormat(0,$env:OFFICE_PDF)
`,
    close: '[void]$doc.Close($false)'
  }
}

/**
 * 生成只读、禁宏的转换脚本，文件路径和 ProgID 只通过环境变量传入。
 * 归属规则：启动 Office 前记下同名进程，启动后新出现的就是本次的实例；Word、Excel 每次都会新开实例，
 * PowerPoint 全机只有一个，用户开着时只能借用。自己的实例最后退出，借用的只关闭自己打开的那份。
 * 实机夹具用 sample 换掉打开和导出两步来生成样例文件，其余流程完全相同。
 */
export function officeComScript(kind: OfficeDocumentKind, sample?: Pick<ComCommands, 'open' | 'export'>): string {
  const commands = { ...COMMANDS[kind], ...sample }

  return (
    PRELUDE +
    String.raw`
$missing=[Type]::Missing
$began=[DateTime]::UtcNow.Ticks
$state=@{began=$began.ToString(); before=@(Get-Process -Name $names -ErrorAction SilentlyContinue|ForEach-Object {$_.Id}); pids=@(); activated=$false; clean=$false}
# 先写完整临时记录，再原子替换；超时后收尾脚本不信任半截记录。
function Write-State {
  $temp=$env:OFFICE_OWNER+'.tmp'
  [IO.File]::WriteAllText($temp,($state|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  if ([IO.File]::Exists($env:OFFICE_OWNER)) {[IO.File]::Replace($temp,$env:OFFICE_OWNER,[NullString]::Value)} else {[IO.File]::Move($temp,$env:OFFICE_OWNER)}
}
# 只记录出错阶段、异常类型和 HRESULT，不记录可能含路径的异常文本。
function Save-Error($key,$record) {
  $cause=$record.Exception.GetBaseException()
  $state[$key]=@{stage=$stage; type=$cause.GetType().FullName; hresult=$cause.HResult; line=$record.InvocationInfo.ScriptLineNumber}
}
# 本次启动后新出现的同名进程。
function Get-New {@(Get-Office $began|Where-Object {$state.before -notcontains $_.Id})}
Write-State
$app=$null; $documents=$null; $doc=$null; $opened=$false; $others=$false; $security=$null; $alerts=$null; $identityWindow=$null; $identityWindows=$null; $failure='unavailable'; $ok=$false
$stage='activation'
try {
  $app=New-Object -ComObject $env:OFFICE_PROGID
  $state.activated=$true; $state.pids=@(Get-New|ForEach-Object {$_.Id}); Write-State
  $documents=$app.${commands.collection}
  $stage='security'
  $security=$app.AutomationSecurity; $state.security=$security; Write-State
  $app.AutomationSecurity=3
  # 只改自己实例的提示设置，借用的实例保持原样。
  if ($state.pids.Count) {$alerts=$app.DisplayAlerts; $app.DisplayAlerts=${commands.alerts}}
  $failure='convert_failed'
  $stage='open'
  try {${commands.open}; $opened=$true} finally {$app.AutomationSecurity=$security; $security=$null}
  $stage='export'
  ${commands.export}
  $ok=$true
} catch {
  $ok=$false; Save-Error 'error' $_
} finally {
  $stage='close'
  try {
    if ($doc) {${commands.close}}
    $opened=$false
  } catch {$ok=$false; $failure='convert_failed'; Save-Error 'cleanupError' $_}
  # 恢复设置或退出失败不影响已经转好的 PDF；退不掉的实例下面再处理。
  try {
    if ($app -and $null -ne $security) {$app.AutomationSecurity=$security}
    if ($app -and $null -ne $alerts) {$app.DisplayAlerts=$alerts}
    $others=($documents -and $documents.Count -gt 0)
    if (-not $state.activated) {$state.pids=@(Get-New|ForEach-Object {$_.Id})}
    elseif ($state.pids.Count -and -not $others) {[void]$app.Quit()}
  } catch {Save-Error 'quitError' $_}
  foreach ($ref in @($identityWindow,$identityWindows,$doc,$documents,$app)) {Release-OfficeObject $ref}
  $identityWindow=$identityWindows=$doc=$documents=$app=$null
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  # 实例里有别人的文档时交给用户，不等也不结束。否则最多等 10 秒退出，仍在且没有可见窗口才结束。
  if (-not $others -and $state.pids.Count) {
    $wait=[Diagnostics.Stopwatch]::StartNew()
    while (@(Get-New|Where-Object {$state.pids -contains $_.Id}).Count -and $wait.ElapsedMilliseconds -lt 10000) {Start-Sleep -Milliseconds 200}
    foreach ($process in @(Get-New|Where-Object {$state.pids -contains $_.Id})) {
      if (-not [PreviewWindows]::Visible($process.Id)) {try {$process.Kill(); [void]$process.WaitForExit(5000)} catch {}}
    }
  }
  $state.clean=(-not $opened) -and ($others -or @(Get-New|Where-Object {$state.pids -contains $_.Id}).Count -eq 0)
  Write-State
}
@{ok=$ok; code=$failure; clean=$state.clean}|ConvertTo-Json -Compress
`
  )
}

/** 转换脚本没能确认收尾时（超时、崩溃）才运行：结束本次启动的实例，或在借用的实例里关闭本次打开的副本。 */
export function officeComCleanupScript(kind: OfficeDocumentKind): string {
  const { collection, close } = COMMANDS[kind]

  return (
    PRELUDE +
    String.raw`
if (-not [IO.File]::Exists($env:OFFICE_OWNER)) {@{ok=$true}|ConvertTo-Json -Compress; exit}
$state=Get-Content -LiteralPath $env:OFFICE_OWNER -Raw -Encoding UTF8|ConvertFrom-Json
$began=[long]$state.began; $pids=@($state.pids); $before=@($state.before)
$ok=$false
try {
  if (-not $state.activated) {
    # 没启动成功就不会打开文档：只结束新出现且没有可见窗口的实例，不影响能否继续尝试其它软件。
    foreach ($process in @(Get-Office $began|Where-Object {$before -notcontains $_.Id})) {
      if (-not [PreviewWindows]::Visible($process.Id)) {try {$process.Kill()} catch {}}
    }
    $ok=$true
  } elseif ($pids.Count) {
    # 本次启动的实例：超时多半卡在弹窗上，弹窗本身就是可见窗口，所以这里不看窗口直接结束。
    foreach ($process in @(Get-Office $began|Where-Object {$pids -contains $_.Id})) {try {$process.Kill(); [void]$process.WaitForExit(5000)} catch {}}
    $ok=@(Get-Office $began|Where-Object {$pids -contains $_.Id}).Count -eq 0
  } elseif (-not @($before|Where-Object {Get-Process -Id $_ -ErrorAction SilentlyContinue}).Count) {
    # 借用的实例已经退出，副本随之关闭。
    $ok=$true
  } else {
    # 借用用户已打开的实例：再次连上它，只关闭本次打开的副本，并恢复宏设置。
    $app=New-Object -ComObject $env:OFFICE_PROGID; $documents=$app.${collection}
    foreach ($doc in @($documents)) {
      if ([string]::Equals($doc.FullName,$env:OFFICE_SOURCE,[StringComparison]::OrdinalIgnoreCase)) {${close}}
      Release-OfficeObject $doc
    }
    if ($null -ne $state.security) {$app.AutomationSecurity=$state.security}
    Release-OfficeObject $documents; Release-OfficeObject $app
    $ok=$true
  }
} catch {$ok=$false}
@{ok=$ok}|ConvertTo-Json -Compress
`
  )
}
