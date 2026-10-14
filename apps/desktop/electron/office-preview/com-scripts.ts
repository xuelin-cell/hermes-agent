import type { OfficeDocumentKind } from '../../../shared/src/office-preview'

// Win32 只用于绑定 COM 窗口与进程，以及确认是否有可见窗口，不能按进程名结束程序。
const WINDOWS = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PreviewWindows {
  // 读取窗口所属进程。
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  // 枚举顶层窗口。
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr data);
  // 读取窗口可见状态。
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  // 只取得查询权限，路径查询不依赖辅助进程与 Office 位数相同。
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint a,bool inherit,int pid);
  // 读取进程实际程序路径。
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr p,int flags,StringBuilder name,ref int size);
  // 展开注册表或启动命令中的短路径。
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetLongPathName(string name,StringBuilder result,uint size);
  // 关闭查询句柄。
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  delegate bool WindowCallback(IntPtr h, IntPtr data);
  // HWND 可能以有符号 32 位值返回，先保留原位模式。
  public static int Pid(long h) {uint p; IntPtr handle=IntPtr.Size==4?new IntPtr(unchecked((int)h)):new IntPtr(unchecked((long)(uint)h)); GetWindowThreadProcessId(handle,out p); return (int)p;}
  // 任意顶层窗口可见时，都不允许强制结束此进程。
  public static bool Visible(int pid) {bool seen=false; EnumWindows((h,d)=>{uint p; GetWindowThreadProcessId(h,out p); seen=seen||(p==pid&&IsWindowVisible(h)); return !seen;},IntPtr.Zero); return seen;}
  // 可靠读取 32／64 位进程路径，不用可能返回 null 的 MainModule。
  public static string ProcessPath(int pid) {IntPtr p=OpenProcess(0x1000,false,pid); if(p==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error()); try {int size=32768; var name=new StringBuilder(size); if(!QueryFullProcessImageName(p,0,name,ref size)) throw new Win32Exception(Marshal.GetLastWin32Error()); var expanded=new StringBuilder(32768); return GetLongPathName(name.ToString(),expanded,32768)>0?expanded.ToString():name.ToString();} finally {CloseHandle(p);}}
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
    bind: String.raw`
if ($env:OFFICE_PROVIDER -eq 'wps' -and $app.Hwnd) {$handle=$app.Hwnd}
else {
  $identityWindows=$app.Windows
  if ($identityWindows.Count -eq 0) {
    if ($app.Visible) {throw 'Visible Word has no bindable document window'}
    # 窗口必须存在才能取 HWND；应用保持隐藏，不改变用户窗口的可见性。
    $probe=$documents.Add($missing,$false,0,$true)
    Release-OfficeObject $identityWindows; $identityWindows=$probe.Windows
  }
  $identityWindow=$identityWindows.Item(1); $handle=$identityWindow.Hwnd
}
Save-Owner $handle
Release-OfficeObject $identityWindow; $identityWindow=$null
Release-OfficeObject $identityWindows; $identityWindows=$null
if ($probe) {[void]$probe.Close($false); Release-OfficeObject $probe; $probe=$null}
`,
    open: '$doc=$documents.Open($env:OFFICE_SOURCE,$false,$true,$false,"",$missing,$false,"",$missing,$missing,$missing,$false)',
    export: '[void]$doc.SaveAs($env:OFFICE_PDF,17)',
    close: '[void]$doc.Close($false)'
  },
  slides: {
    collection: 'Presentations',
    alerts: '1',
    bind: String.raw`
$handle=[long]$app.HWND
# 部分 WPS 演示不实现 HWND；只允许对象级收尾，不能猜测或强杀进程。
if ($env:OFFICE_PROVIDER -eq 'wps' -and [PreviewWindows]::Pid($handle) -le 0) {$state.windowless=$true; Write-State}
else {Save-Owner $handle}
`,
    open: '$doc=$documents.Open($env:OFFICE_SOURCE,-1,0,0)',
    export: '[void]$doc.SaveAs($env:OFFICE_PDF,32)',
    close: '[void]$doc.Close()'
  },
  sheet: {
    collection: 'Workbooks',
    alerts: '$false',
    bind: 'Save-Owner $app.Hwnd',
    open: '$doc=$documents.Open($env:OFFICE_SOURCE,0,$true,$missing,"","",$true); $identityWindows=$doc.Windows; $identityWindow=$identityWindows.Item(1); $identityWindow.Visible=$false; Release-OfficeObject $identityWindow; $identityWindow=$null; Release-OfficeObject $identityWindows; $identityWindows=$null',
    export:
      '$worksheets=$doc.Worksheets; try {foreach ($sheet in $worksheets) {try {$setup=$sheet.PageSetup; $setup.Zoom=$false; $setup.FitToPagesWide=1; $setup.FitToPagesTall=$false} finally {Release-OfficeObject $setup; $setup=$null; Release-OfficeObject $sheet; $sheet=$null}}} finally {Release-OfficeObject $worksheets; $worksheets=$null}; [void]$doc.ExportAsFixedFormat(0,$env:OFFICE_PDF)',
    close: '[void]$doc.Close($false)'
  }
}

// 实机夹具通过同一保护流程创建原生样例，避免另写一套不安全的 COM 启停逻辑。
const SAMPLES: Record<OfficeDocumentKind, Pick<ComCommands, 'open' | 'export'>> = {
  word: {
    open: '$doc=$documents.Add($missing,$false,0,$false); $range=$doc.Content; try {$range.Text="中文 Office 预览测试"} finally {Release-OfficeObject $range; $range=$null}',
    export: '[void]$doc.SaveAs($env:OFFICE_PDF,12)'
  },
  slides: {
    open: '$doc=$documents.Add(0); $slides=$doc.Slides; $slide=$slides.Add(1,12); $shapes=$slide.Shapes; $shape=$shapes.AddTextbox(1,40,40,640,100); $frame=$shape.TextFrame; $range=$frame.TextRange; $range.Text="中文幻灯片预览测试"; foreach ($ref in @($range,$frame,$shape,$shapes,$slide,$slides)) {Release-OfficeObject $ref}; $range=$frame=$shape=$shapes=$slide=$slides=$null',
    export: '[void]$doc.SaveAs($env:OFFICE_PDF,24)'
  },
  sheet: {
    open: '$doc=$documents.Add(); $worksheets=$doc.Worksheets; $sheet=$worksheets.Item(1); $cells=$sheet.Cells; $first=$cells.Item(1,1); $second=$cells.Item(2,1); $first.Value2="中文表格预览测试"; $second.Value2=12345; foreach ($ref in @($second,$first,$cells,$sheet,$worksheets)) {Release-OfficeObject $ref}; $second=$first=$cells=$sheet=$worksheets=$null',
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
$paths=[string[]](ConvertFrom-Json $env:OFFICE_PATHS)
$names=@($paths|ForEach-Object {[IO.Path]::GetFileNameWithoutExtension($_)}|Select-Object -Unique)
$before=@(Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object {$_.Id})
$state=@{before=$before; began=[DateTime]::UtcNow.Ticks.ToString(); executable=$env:OFFICE_PROGRAM; paths=$paths; closed=$false}
# 先写完整临时记录，再原子替换；超时后不信任半截记录。
function Write-State {
  $temp=$env:OFFICE_OWNER+'.tmp'
  [IO.File]::WriteAllText($temp,($state|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  if ([IO.File]::Exists($env:OFFICE_OWNER)) {[IO.File]::Replace($temp,$env:OFFICE_OWNER,[NullString]::Value)} else {[IO.File]::Move($temp,$env:OFFICE_OWNER)}
}
# 记录窗口绑定的 PID 与创建时间；路径冲突保留诊断，但禁止操作该进程。
function Save-Owner($handle) {
  $processId=[PreviewWindows]::Pid([long]$handle)
  if ($processId -le 0) {$state.handle=[long]$handle; Write-State; throw 'No COM process identity'}
  $process=Get-Process -Id $processId
  $state.pid=$processId; $state.started=$process.StartTime.ToUniversalTime().Ticks.ToString()
  $state.actualExecutable=[PreviewWindows]::ProcessPath($processId)
  $state.matched=($paths -contains $state.actualExecutable)
  $state.created=($before -notcontains $processId -and [long]$state.started -ge [long]$state.began)
  Write-State
  if (-not $state.matched) {throw 'COM executable mismatch'}
  $state.executable=$state.actualExecutable; Write-State
}
Write-State
$app=$null; $doc=$null; $probe=$null; $documents=$null; $identityWindow=$null; $identityWindows=$null; $security=$null; $alerts=$null; $failure='unavailable'; $ok=$false
$stage='activation'
# 仅释放真实 COM 引用，不能把普通返回值当作 COM 对象释放。
function Release-OfficeObject($value) {
  if ($value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) {[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($value)}
}
try {
  $app=New-Object -ComObject $env:OFFICE_PROGID
  $state.activated=$true; Write-State
  $documents=$app.${commands.collection}; $initialCount=$documents.Count
  $stage='security'
  $security=$app.AutomationSecurity
  $app.AutomationSecurity=3
  $stage='identity'
  ${commands.bind}
  if ($state.created) {$alerts=$app.DisplayAlerts; $app.DisplayAlerts=${commands.alerts}}
  $failure='convert_failed'
  $stage='open'
  try {${commands.open}} finally {$app.AutomationSecurity=$security; $security=$null}
  $stage='export'
  ${commands.export}
  $ok=$true
} catch {
  $ok=$false
  $cause=$_.Exception.GetBaseException()
  $state.error=@{stage=$stage; type=$cause.GetType().FullName; hresult=$cause.HResult; line=$_.InvocationInfo.ScriptLineNumber}
} finally {
  try {
    if ($doc) {${commands.close}; Release-OfficeObject $doc; $doc=$null}
    Release-OfficeObject $identityWindow; $identityWindow=$null
    Release-OfficeObject $identityWindows; $identityWindows=$null
    if ($probe) {${commands.close.replace('$doc', '$probe')}; Release-OfficeObject $probe; $probe=$null}
    if ($app -and $null -ne $security) {$app.AutomationSecurity=$security}
    if ($app -and $null -ne $alerts) {$app.DisplayAlerts=$alerts}
    $state.otherDocuments=($documents -and $documents.Count -gt 0)
    $state.closed=($ok -or -not $app -or $documents.Count -le $initialCount)
    Write-State
    # 已确认的自有空实例先结束，再释放客户端引用，避免远端 Release 长时间阻塞。
    if ($state.created -and $state.matched -and -not $state.otherDocuments -and -not [PreviewWindows]::Visible($state.pid)) {
      $owned=Get-Process -Id $state.pid -ErrorAction SilentlyContinue
      if ($owned -and $owned.StartTime.ToUniversalTime().Ticks.ToString() -eq $state.started -and [string]::Equals([PreviewWindows]::ProcessPath($state.pid),$state.executable,[StringComparison]::OrdinalIgnoreCase) -and -not [PreviewWindows]::Visible($state.pid)) {
        $owned.Kill(); $state.stopped=$owned.WaitForExit(5000); Write-State
      }
    }
  } catch {
    $ok=$false; $failure='convert_failed'; $state.closed=$false
    $cause=$_.Exception.GetBaseException()
    $state.cleanupError=@{type=$cause.GetType().FullName; hresult=$cause.HResult; line=$_.InvocationInfo.ScriptLineNumber}
    Write-State
  } finally {
    # 未登记的独立 Word／Excel 单独退出；前面的设置恢复失败也不能漏掉它。
    try {
      if ($app -and -not $state.matched -and $null -eq $state.actualExecutable -and $env:OFFICE_STANDALONE -eq '1' -and $documents -and $documents.Count -eq 0 -and -not $app.Visible -and -not $app.UserControl) {[void]$app.Quit(); $state.quit=$true; $state.closed=$true; Write-State}
    } catch {
      $ok=$false; $failure='convert_failed'; $state.closed=$false
      $cause=$_.Exception.GetBaseException()
      $state.cleanupError=@{type=$cause.GetType().FullName; hresult=$cause.HResult; line=$_.InvocationInfo.ScriptLineNumber}
      Write-State
    }
  }
  if (-not $state.stopped) {Release-OfficeObject $documents; Release-OfficeObject $app; [GC]::Collect(); [GC]::WaitForPendingFinalizers()}
  $documents=$app=$null
}
if ($ok) {@{ok=$true}|ConvertTo-Json -Compress} else {@{ok=$false; code=$failure}|ConvertTo-Json -Compress}
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
  $names=@($state.paths|ForEach-Object {[IO.Path]::GetFileNameWithoutExtension($_)}|Select-Object -Unique)
  $new=@(Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object {$_.Id -notin $state.before -and $_.StartTime.ToUniversalTime().Ticks -ge [long]$state.began})
  $safe=($new.Count -eq 0 -and ($state.closed -or -not $state.activated))
} else {
  $process=Get-Process -Id $state.pid -ErrorAction SilentlyContinue
  if (-not $process) {$safe=$true}
  elseif ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $state.started -or $state.matched -eq $false -or -not [string]::Equals([PreviewWindows]::ProcessPath($state.pid),$state.executable,[StringComparison]::OrdinalIgnoreCase)) {$safe=$false}
  elseif (-not $state.created -or $state.otherDocuments -or [PreviewWindows]::Visible($state.pid)) {$safe=[bool]$state.closed}
  elseif (-not [PreviewWindows]::Visible($state.pid)) {$process.Kill(); $safe=$process.WaitForExit(5000)}
}
@{ok=$safe}|ConvertTo-Json -Compress
`
