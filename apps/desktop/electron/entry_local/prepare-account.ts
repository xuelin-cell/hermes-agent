import { MAAS_IDENTITY_NAMESPACE } from '../login/credential-store'
import type { LoginSession } from '../login/session'

import { type AccountPaths, type AccountRoots, prepareAccountPaths } from './account-paths'
import { mergeMaasModelConfig } from './model-config'
import { writeAccountMaasKey } from './model-key'
import { LocalStartupError } from './startup-failure'

/** 只从主进程 LoginSession 取得有效 UID，不接受页面指定账号或目录。 */
export function prepareLocalAccount(session: LoginSession, roots: AccountRoots): AccountPaths {
  const identity = session.currentIdentity()

  if (!identity) {
    throw new Error('请先登录有效的 MaaS 账号。')
  }

  try {
    return prepareAccountPaths(roots, MAAS_IDENTITY_NAMESPACE, identity.uid)
  } catch (error) {
    // 原始文件系统错误可能含账号路径，不能直接交给页面或日志。
    throw new LocalStartupError('directory', error)
  }
}

/** 准备账号配置和专用 Key；明确无套餐清空 Key，查询失败保留文件，不冒充刷新成功。 */
export function prepareLocalEnvironment(session: LoginSession, roots: AccountRoots): AccountPaths {
  const account = prepareLocalAccount(session, roots)
  const result = session.currentPlan()

  if (result.status === 'available') {
    try {
      mergeMaasModelConfig(account.home, result.plan)
    } catch (error) {
      throw new LocalStartupError('config', error)
    }
  }

  if (result.status === 'available' || result.status === 'empty') {
    try {
      writeAccountMaasKey(account.home, result.status === 'available' ? result.plan.apiKey : null)
    } catch (error) {
      throw new LocalStartupError('credentials', error)
    }
  }

  return account
}
