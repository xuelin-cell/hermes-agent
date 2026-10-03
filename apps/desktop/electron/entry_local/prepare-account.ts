import { MAAS_IDENTITY_NAMESPACE } from '../login/credential-store'
import type { LoginSession } from '../login/session'

import { type AccountPaths, type AccountRoots, prepareAccountPaths } from './account-paths'

/** 只从主进程 LoginSession 取得有效 UID，不接受页面指定账号或目录。 */
export function prepareLocalAccount(session: LoginSession, roots: AccountRoots): AccountPaths {
  const identity = session.currentIdentity()

  if (!identity) {
    throw new Error('请先登录有效的 MaaS 账号。')
  }

  try {
    return prepareAccountPaths(roots, MAAS_IDENTITY_NAMESPACE, identity.uid)
  } catch {
    // 原始文件系统错误可能含账号路径，不能直接交给页面或日志。
    throw new Error('账号目录准备失败，请检查本地目录后重试。')
  }
}
