import { execFileSync } from 'node:child_process'

export interface LogoutProcess {
  pid: number
  parent: number
  started: string
}

/** 只读取进程关系与创建时间，不采集可能包含凭据的命令行。 */
export function listLogoutProcesses(): LogoutProcess[] {
  if (process.platform !== 'win32') {
    throw new Error('当前退出验证仅支持 Windows。')
  }

  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parent';e={[int]$_.ParentProcessId}},@{n='started';e={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().Ticks.ToString()} else {''}}}) | ConvertTo-Json -Compress"
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 }
  )

  const rows: unknown = JSON.parse(output)

  if (
    !Array.isArray(rows) ||
    rows.some(
      row =>
        !Number.isInteger(row.pid) ||
        !Number.isInteger(row.parent) ||
        typeof row.started !== 'string' ||
        !/^\d*$/.test(row.started)
    )
  ) {
    throw new Error('无法确认账号进程状态。')
  }

  return rows
}

/** 从本次实际创建的后端向下收集子树，不按名字或安装目录扩大范围。 */
export function logoutProcessTree(rows: LogoutProcess[], roots: number[]): LogoutProcess[] {
  if (roots.some(pid => !rows.some(row => row.pid === pid && row.started))) {
    throw new Error('无法确认后端创建时间。')
  }

  const selected = new Set(roots)
  let changed = true

  while (changed) {
    changed = false

    for (const row of rows) {
      const parent = rows.find(item => item.pid === row.parent)

      if (selected.has(row.parent) && !row.started) {
        throw new Error('无法确认子进程创建时间。')
      }

      if (
        !selected.has(row.pid) &&
        selected.has(row.parent) &&
        parent &&
        BigInt(row.started) >= BigInt(parent.started)
      ) {
        selected.add(row.pid)
        changed = true
      }
    }
  }

  return rows.filter(row => selected.has(row.pid))
}

/** 先直接探测已保存的 PID；权限不足仍算存活，未知错误不能放行。 */
function logoutProcessPresent(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    if (code === 'ESRCH') {return false}

    if (code === 'EPERM') {return true}

    throw new Error('无法确认账号进程状态。')
  }
}

/** 原版收尾后只补清理存活 PID；无残留时不启动 PowerShell。 */
export function stopLogoutProcesses(owned: LogoutProcess[]): void {
  for (const row of owned) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !/^\d+$/.test(row.started)) {
      throw new Error('无效进程归属。')
    }
  }

  const pending = owned.filter(row => logoutProcessPresent(row.pid))

  if (!pending.length) {return}

  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'
$owned=ConvertFrom-Json ([Console]::In.ReadToEnd())
foreach ($row in $owned) {
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$row.pid)
  if ($p -and -not $p.CreationDate) {throw '无法确认进程创建时间'}
  if ($p -and $p.CreationDate.ToUniversalTime().Ticks.ToString() -eq $row.started) {
    $ErrorActionPreference='Continue'
    & taskkill.exe /PID $row.pid /T /F 2>$null | Out-Null
    $ErrorActionPreference='Stop'
  }
}
# Job Object 可能提前收掉后代；taskkill 退出码不能代替最后的存活验证。
$filter=($owned | ForEach-Object {'ProcessId='+$_.pid}) -join ' OR '
ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter $filter | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='started';e={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().Ticks.ToString()} else {''}}})`
    ],
    {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
      // 身份作为数据从标准输入传入，避免拼接命令或超出 Windows 命令行长度。
      input: JSON.stringify(pending.map(({ pid, started }) => ({ pid, started })))
    }
  )

  const remaining: LogoutProcess[] = JSON.parse(output)

  if (
    !Array.isArray(remaining) ||
    remaining.some(row => !row || !Number.isInteger(row.pid) || typeof row.started !== 'string' || !/^\d*$/.test(row.started))
  ) {throw new Error('无法确认账号进程状态。')}

  if (
    pending.some(row => remaining.some(item => item.pid === row.pid && (!item.started || item.started === row.started)))
  ) {
    throw new Error('账号后端或工具子进程尚未停止。')
  }
}
