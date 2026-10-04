import fs from 'node:fs'
import path from 'node:path'

import type { LoginAccount } from '../login/contract'
import { MAAS_IDENTITY_NAMESPACE } from '../login/credential-store'
import type { LoginSession } from '../login/session'
import { resolveSourcePython } from '../source-python'

import { type AccountPaths, type AccountRoots, resolveAccountPaths } from './account-paths'
import { prepareLocalEnvironment } from './prepare-account'

export interface PreparedLocalContext extends Readonly<AccountPaths> {
  readonly installationRoot: string
  readonly python: string
}

/** 主进程持有身份和固定路径；本模块不导入聊天运行时，也不修改进程环境。 */
export class LocalRuntimeContext {
  private context: PreparedLocalContext | null = null
  private prepared = false
  private account: LoginAccount | null = null
  private readonly roots: Readonly<AccountRoots>
  private readonly installationRoot: string

  /** 捕获受管根和开发安装位置，不从页面、旧连接或旧账号提示选择目录。 */
  constructor(
    readonly login: LoginSession,
    roots: AccountRoots,
    installationRoot: string,
    private readonly pythonOverride?: string
  ) {
    this.roots = Object.freeze({ ...roots })
    this.installationRoot = path.resolve(installationRoot)
  }

  /** 准备成功才发布上下文；再次准备可刷新配置，但不能更换账号或解释器。 */
  prepare(): PreparedLocalContext {
    this.prepared = false
    const identity = this.login.currentIdentity()

    if (!identity) {
      throw new Error('请先登录有效的 MaaS 账号。')
    }

    const account = resolveAccountPaths(this.roots, MAAS_IDENTITY_NAMESPACE, identity.uid)

    if (this.context && this.context.id !== account.id) {
      throw new Error('本次运行不能更换账号，请完整退出后重新登录。')
    }

    const python = this.context?.python ?? resolveSourcePython(this.installationRoot, { override: this.pythonOverride })

    try {
      if (!fs.statSync(path.join(this.installationRoot, 'hermes_cli', 'main.py')).isFile()) {
        throw new Error()
      }
    } catch {
      throw new Error('开发仓库不完整，请检查源码安装位置。')
    }

    try {
      if (!python || !fs.statSync(python).isFile()) {
        throw new Error()
      }
    } catch {
      throw new Error('开发仓库的 Python 不存在，请先准备开发运行时。')
    }

    const paths = prepareLocalEnvironment(this.login, this.roots)
    this.context ??= Object.freeze({ ...paths, installationRoot: this.installationRoot, python })
    const plan = this.login.currentPlan()
    this.account = {
      maskedPhone: identity.maskedPhone,
      expiresAt: identity.expiresAt,
      ...(plan.status === 'failed' && plan.reason === 'auth' ? { planAuthRejected: true as const } : {})
    }
    this.prepared = true

    return this.context
  }

  /** 保留本次已准备的固定环境；运行中登录到期不停止任务或改变账号。 */
  current(): PreparedLocalContext | null {
    return this.prepared ? this.context : null
  }

  /** 展示已准备账号的原期限；副本不含凭据，也不用于登录恢复或授权请求。 */
  currentAccount(): LoginAccount | null {
    return this.prepared && this.account ? { ...this.account } : null
  }

  /** 应用退出或取消启动时释放身份；只清内存，不删除账号文件。 */
  dispose(): void {
    this.prepared = false
    this.account = null
    this.login.dispose()
  }
}
