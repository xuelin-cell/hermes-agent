import { type ChildProcess, execFileSync } from 'node:child_process'

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

/** 每次停止前复核创建时间；PID 被复用时不触碰新进程。 */
export function stopLogoutProcesses(owned: LogoutProcess[]): void {
  for (const row of owned) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !/^\d+$/.test(row.started)) {
      throw new Error('无效进程归属。')
    }

    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Job Object 可能先收掉后代；taskkill 的退出码不能代替最后的存活验证。
        `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${row.pid}'; if ($p -and $p.CreationDate.ToUniversalTime().Ticks.ToString() -eq '${row.started}') { $ErrorActionPreference='Continue'; & taskkill.exe /PID ${row.pid} /T /F 2>$null | Out-Null }; exit 0`
      ],
      { windowsHide: true, timeout: 15_000 }
    )
  }

  const remaining = listLogoutProcesses()

  if (
    owned.some(row => remaining.some(item => item.pid === row.pid && (!item.started || item.started === row.started)))
  ) {
    throw new Error('账号后端或工具子进程尚未停止。')
  }
}

/** 等待原始子进程句柄报告退出，不对可能已复用的 PID 再次发信号。 */
export function confirmLogoutChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    /** 退出事件或超时都清理监听器；超时保留整个退出事务。 */
    function finish(): void {
      clearTimeout(timer)
      child.removeListener('exit', finish)

      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
      } else {
        reject(new Error('后端退出事件尚未确认。'))
      }
    }

    const timer = setTimeout(finish, 5000)
    child.once('exit', finish)
  })
}
