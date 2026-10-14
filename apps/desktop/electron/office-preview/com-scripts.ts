import type { OfficeDocumentKind } from '../../../shared/src/office-preview'

// Win32 只用于绑定 COM 窗口与进程，以及确认是否有可见窗口，不能按进程名结束程序。
const WINDOWS = String.raw`
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
  // HWND 可能以有符号 32 位值返回，先保留原位模式。
  public static int Pid(long h) {uint p; IntPtr handle=IntPtr.Size==4?new IntPtr(unchecked((int)h)):new IntPtr(unchecked((long)(uint)h)); GetWindowThreadProcessId(handle,out p); return (int)p;}
  // 任意顶层窗口可见时，都不允许强制结束此进程。
  public static bool Visible(int pid) {bool seen=false; EnumWindows((h,d)=>{uint p; GetWindowThreadProcessId(h,out p); seen=seen||(p==pid&&IsWindowVisible(h)); return !seen;},IntPtr.Zero); return seen;}
}
'@
`

interface ComCommands {
  collection: string
  bind: string
  open: string
  export: string
  close: string
  alerts: string
}

const COMMANDS: Record<OfficeDocumentKind, ComCommands> = {
  word: {
    collection: 'Documents',
    alerts: '0',
    bind: '$probe=$null; if ($app.Windows.Count -gt 0) {$handle=$app.Windows.Item(1).Hwnd} else {$probe=$app.Documents.Add($missing,$false,0,$false); $handle=$probe.Windows.Item(1).Hwnd}; Save-Owner $handle; if ($probe) {[void]$probe.Close($false); Release-OfficeObject $probe; $probe=$null}',
    open: '$doc=$app.Documents.Open($env:OFFICE_SOURCE,$false,$true,$false,"",$missing,$false,"",$missing,$missing,$missing,$false)',
    export: '[void]$doc.SaveAs($env:OFFICE_PDF,17)',
    close: '[void]$doc.Close($false)'
  },
  slides: {
    collection: 'Presentations',
    alerts: '1',
    bind: 'Save-Owner $app.HWND',
    open: '$doc=$app.Presentations.Open($env:OFFICE_SOURCE,-1,0,0)',
    export: '[void]$doc.SaveAs($env:OFFICE_PDF,32)',
    close: '[void]$doc.Close()'
  },
  sheet: {
    collection: 'Workbooks',
    alerts: '$false',
    bind: 'Save-Owner $app.Hwnd',
    open: '$doc=$app.Workbooks.Open($env:OFFICE_SOURCE,0,$true,$missing,"","",$true); $doc.Windows.Item(1).Visible=$false',
    export:
      'foreach ($sheet in $doc.Worksheets) {try {$sheet.PageSetup.Zoom=$false; $sheet.PageSetup.FitToPagesWide=1; $sheet.PageSetup.FitToPagesTall=$false} finally {Release-OfficeObject $sheet}}; [void]$doc.ExportAsFixedFormat(0,$env:OFFICE_PDF)',
    close: '[void]$doc.Close($false)'
  }
}

// 实机夹具通过同一保护流程创建原生样例，避免另写一套不安全的 COM 启停逻辑。
const SAMPLES: Record<OfficeDocumentKind, Pick<ComCommands, 'open' | 'export'>> = {
  word: {
    open: '$doc=$app.Documents.Add($missing,$false,0,$false); $doc.Content.Text="中文 Office 预览测试"',
    export: '[void]$doc.SaveAs($env:OFFICE_PDF,12)'
  },
  slides: {
    open: '$doc=$app.Presentations.Add(0); $slide=$doc.Slides.Add(1,12); $shape=$slide.Shapes.AddTextbox(1,40,40,640,100); $shape.TextFrame.TextRange.Text="中文幻灯片预览测试"; Release-OfficeObject $shape; Release-OfficeObject $slide',
    export: '[void]$doc.SaveAs($env:OFFICE_PDF,24)'
  },
  sheet: {
    open: '$doc=$app.Workbooks.Add(); $doc.Worksheets.Item(1).Cells.Item(1,1).Value2="中文表格预览测试"; $doc.Worksheets.Item(1).Cells.Item(2,1).Value2=12345',
    export: '[void]$doc.SaveAs($env:OFFICE_PDF,51)'
  }
}

/** 生成同一套只读、禁宏转换脚本，文件路径和 ProgID 只通过子进程环境传入。 */
export function officeComScript(kind: OfficeDocumentKind, sample = false): string {
  const commands = sample ? { ...COMMANDS[kind], ...SAMPLES[kind] } : COMMANDS[kind]

  return (
    WINDOWS +
    String.raw`
$missing=[Type]::Missing
$before=@(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($env:OFFICE_PROGRAM)) -ErrorAction SilentlyContinue | ForEach-Object {$_.Id})
$state=@{before=$before; began=[DateTime]::UtcNow.Ticks.ToString(); executable=$env:OFFICE_PROGRAM; closed=$false}
# 先写完整临时记录，再原子替换；超时后不信任半截记录。
function Write-State {
  $temp=$env:OFFICE_OWNER+'.tmp'
  [IO.File]::WriteAllText($temp,($state|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  if ([IO.File]::Exists($env:OFFICE_OWNER)) {[IO.File]::Replace($temp,$env:OFFICE_OWNER,[NullString]::Value)} else {[IO.File]::Move($temp,$env:OFFICE_OWNER)}
}
# COM 窗口绑定到实际 PID；只记录准确路径与创建时间匹配的实例。
function Save-Owner($handle) {
  $processId=[PreviewWindows]::Pid([long]$handle)
  if ($processId -le 0) {throw 'No COM process identity'}
  $process=Get-Process -Id $processId
  if (-not [string]::Equals($process.Path,$env:OFFICE_PROGRAM,[StringComparison]::OrdinalIgnoreCase)) {throw 'COM executable mismatch'}
  $state.pid=$processId; $state.started=$process.StartTime.ToUniversalTime().Ticks.ToString()
  $state.created=($before -notcontains $processId -and [long]$state.started -ge [long]$state.began)
  Write-State
}
Write-State
$app=$null; $doc=$null; $probe=$null; $security=$null; $alerts=$null; $failure='unavailable'; $ok=$false
# 仅释放真实 COM 引用，不能把普通返回值当作 COM 对象释放。
function Release-OfficeObject($value) {
  if ($value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) {[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($value)}
}
try {
  $app=New-Object -ComObject $env:OFFICE_PROGID
  $security=$app.AutomationSecurity
  $app.AutomationSecurity=3
  ${commands.bind}
  $initialCount=$app.${commands.collection}.Count
  if ($state.created) {$alerts=$app.DisplayAlerts; $app.DisplayAlerts=${commands.alerts}}
  $failure='convert_failed'
  try {${commands.open}} finally {$app.AutomationSecurity=$security; $security=$null}
  ${commands.export}
  $ok=$true
} catch {$ok=$false} finally {
  try {
    if ($doc) {${commands.close}; Release-OfficeObject $doc; $doc=$null}
    if ($probe) {[void]$probe.Close($false); Release-OfficeObject $probe}
    if ($app -and $null -ne $security) {$app.AutomationSecurity=$security}
    if ($app -and $null -ne $alerts) {$app.DisplayAlerts=$alerts}
    $state.otherDocuments=($app -and $app.${commands.collection}.Count -gt 0)
    $state.closed=($ok -or -not $app -or $app.${commands.collection}.Count -le $initialCount); Write-State
    if ($app -and $state.created -and -not $state.otherDocuments -and -not [PreviewWindows]::Visible($state.pid)) {[void]$app.Quit()}
  } catch {$ok=$false; $failure='convert_failed'}
  Release-OfficeObject $app
}
@{ok=$ok; code=$failure}|ConvertTo-Json -Compress
`
  )
}

/** 异常后仅结束本次新建、创建时间及路径仍匹配且不可见的 Office，未知归属不动。 */
export const OFFICE_COM_CLEANUP =
  WINDOWS +
  String.raw`
if (-not [IO.File]::Exists($env:OFFICE_OWNER)) {@{ok=$true}|ConvertTo-Json -Compress; exit}
$state=Get-Content -LiteralPath $env:OFFICE_OWNER -Raw -Encoding UTF8|ConvertFrom-Json
$safe=$false
if (-not $state.pid) {
  $new=@(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($state.executable)) -ErrorAction SilentlyContinue | Where-Object {$_.Id -notin $state.before -and $_.StartTime.ToUniversalTime().Ticks -ge [long]$state.began})
  $safe=($new.Count -eq 0)
} else {
  $process=Get-Process -Id $state.pid -ErrorAction SilentlyContinue
  if (-not $process) {$safe=$true}
  elseif ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $state.started -or -not [string]::Equals($process.Path,$state.executable,[StringComparison]::OrdinalIgnoreCase)) {$safe=$false}
  elseif (-not $state.created -or $state.otherDocuments -or [PreviewWindows]::Visible($state.pid)) {$safe=[bool]$state.closed}
  elseif (-not [PreviewWindows]::Visible($state.pid)) {$process.Kill(); $safe=$process.WaitForExit(5000)}
}
@{ok=$safe}|ConvertTo-Json -Compress
`
