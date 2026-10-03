import { createHash } from 'node:crypto'

import type { AccountPaths } from './account-paths'

/** 给原有用途加上可信账号归属，保留持久性且避免 Windows 分区名转义。 */
export function accountBrowserPartition(account: Pick<AccountPaths, 'id'>, partition: string): string {
  const persistent = partition.startsWith('persist:')
  const purpose = persistent ? partition.slice('persist:'.length) : partition
  const digest = createHash('sha256').update(JSON.stringify([account.id, purpose]), 'utf8').digest('hex')

  return `${persistent ? 'persist:' : ''}hermes-mt-${digest}`
}
