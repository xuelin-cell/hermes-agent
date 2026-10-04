import fs from 'node:fs'
import path from 'node:path'

import { processStartMarker, REAP_PROBE_TIMEOUT_MS } from '../backend-claim'
import { parseBackendOwnershipDetailed, serializeBackendOwnership } from '../backend-ownership'
import { writeSecretFileAtomic } from '../hardening'
import { electronProcessStartMarker } from '../parent-process-identity'
import { resolveSourcePython } from '../source-python'

import { accountPathsById, type AccountRoots } from './account-paths'
import { accountDesktopStatePaths } from './desktop-state'
import { accountGatewayLogout, gatewayLogoutRoots } from './gateway-logout'
import { type AccountExitMode, completeAccountExit, logoutIntentPath } from './logout'
import { listLogoutProcesses, type LogoutProcess, logoutProcessTree, stopLogoutProcesses } from './logout-processes'

interface PendingAccount {
  account: string
  mode: AccountExitMode
  processes?: LogoutProcess[]
}

/** 缺文件与坏文件分开；链接、读取错误和解析错误均保留原件并阻止启动。 */
function readRecord(file: string): string | null {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })

  if (!stat) {
    return null
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('账号恢复记录不是普通文件。')
  }

  return fs.readFileSync(file, 'utf8')
}

/** 只接收既有退出记录的完整结构，不从损坏记录猜测账号或进程。 */
function readPendingAccount(text: string): PendingAccount {
  const value = JSON.parse(text)

  if (
    !value ||
    typeof value.account !== 'string' ||
    !/^account-[a-f0-9]{64}$/.test(value.account) ||
    !['quit', 'logout'].includes(value.mode) ||
    (value.processes !== undefined &&
      (!Array.isArray(value.processes) ||
        value.processes.some(
          row =>
            !row ||
            !Number.isSafeInteger(row.pid) ||
            row.pid <= 0 ||
            !Number.isSafeInteger(row.parent) ||
            row.parent < 0 ||
            typeof row.started !== 'string' ||
            !/^\d+$/.test(row.started)
        )))
  ) {
    throw new Error('账号恢复记录不完整。')
  }

  return value
}

/** 重开只作一次清理；依据原账号记录处理进程，成功前不读取登录或加载桌面。 */
export async function recoverAccountRun(
  roots: AccountRoots,
  installationRoot: string,
  pythonOverride?: string
): Promise<void> {
  const marker = logoutIntentPath(roots.userData)
  const text = readRecord(marker)

  if (text === null) {
    return
  }

  const pending = readPendingAccount(text)
  const account = accountPathsById(roots, pending.account)

  for (const directory of [
    ...[roots.data, roots.userData].flatMap(root => [
      root,
      path.join(root, 'accounts'),
      path.join(root, 'accounts', account.id)
    ]),
    account.home,
    account.workspace,
    account.desktopState
  ]) {
    const stat = fs.lstatSync(directory)

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('账号恢复目录无效。')
    }
  }

  const ownershipFile = accountDesktopStatePaths(account).backendOwnership
  const ownershipText = readRecord(ownershipFile)
  const ownership = parseBackendOwnershipDetailed(ownershipText)
  const raw = ownershipText === null ? { backends: [] } : JSON.parse(ownershipText)

  if (ownership.corrupt || !raw || !Array.isArray(raw.backends) || raw.backends.length !== ownership.entries.length) {
    throw new Error('后端归属记录不完整。')
  }

  const rows = listLogoutProcesses()
  const backendRoots: number[] = []

  for (const entry of ownership.entries) {
    if (!rows.some(row => row.pid === entry.pid)) {
      continue
    }

    // 活进程必须有可复核指纹；不使用原版面向非账号模式的 PID-only 降级。
    if (!/^win:\d+$/.test(entry.startMarker)) {
      throw new Error('后端创建时间无法确认。')
    }

    try {
      if ((await processStartMarker(entry.pid, REAP_PROBE_TIMEOUT_MS)) !== entry.startMarker) {
        continue
      }
    } catch (error) {
      if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        continue
      }

      throw error
    }

    if (
      !Number.isSafeInteger(entry.parentPid) ||
      entry.parentPid! <= 0 ||
      !/^win(?:ms)?:\d+$/.test(entry.parentStartMarker ?? '')
    ) {
      throw new Error('后端父进程归属无法确认。')
    }

    // 单实例锁之外仍核对旧父进程，避免处理其他尚存活实例的工作。
    const parent = rows.find(row => row.pid === entry.parentPid)

    if (parent) {
      if (!parent.started) {
        throw new Error('后端父进程归属无法确认。')
      }

      // 沿用原版毫秒指纹；系统 ticks 指纹只容许探针的亚毫秒精度差异。
      const milliseconds = Number((BigInt(parent.started) - 621355968000000000n) / 10_000n)

      const difference = entry.parentStartMarker!.startsWith('win:')
        ? BigInt(entry.parentStartMarker!.slice(4)) - BigInt(parent.started)
        : null

      if (
        entry.parentStartMarker === electronProcessStartMarker(parent.pid, parent.pid, milliseconds) ||
        (difference !== null && difference > -10_000n && difference < 10_000n)
      ) {
        throw new Error('上次账号实例仍在运行。')
      }
    }

    backendRoots.push(entry.pid)
  }

  const python = resolveSourcePython(installationRoot, { override: pythonOverride })

  if (!python) {
    throw new Error('账号恢复运行组件不可用。')
  }

  const context = { ...account, installationRoot, python }
  const owned = new Map<string, LogoutProcess>()

  for (const row of [...(pending.processes ?? []), ...logoutProcessTree(rows, backendRoots)]) {
    owned.set(`${row.pid}:${row.started}`, row)
  }

  // 先保存普通子树，随后网关查询或停止失败也不会丢掉已经取得的归属。
  pending.processes = [...owned.values()]
  writeSecretFileAtomic(marker, JSON.stringify(pending))
  const gateways = await accountGatewayLogout(context, 'snapshot')
  const gatewayProcesses = listLogoutProcesses()

  for (const row of logoutProcessTree(gatewayProcesses, gatewayLogoutRoots(gateways, gatewayProcesses))) {
    owned.set(`${row.pid}:${row.started}`, row)
  }

  pending.processes = [...owned.values()]
  writeSecretFileAtomic(marker, JSON.stringify(pending))
  await accountGatewayLogout(context, 'stop', gateways)
  stopLogoutProcesses(pending.processes)
  await accountGatewayLogout(context, 'check')
  writeSecretFileAtomic(ownershipFile, serializeBackendOwnership([]))
  completeAccountExit(roots.userData, pending.mode)
}
