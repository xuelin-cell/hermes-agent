import path from 'node:path'

import { copyTitlePluginFiles } from '../conversation-titles/install'
import type { CloudDriveMcp, ProfileConfigApi } from '../login/cloud-drive-mcp'

import { copyArtifactSharePlugin } from './install-artifact-share'
import type { InterruptedTurns } from './interrupted-turns'
import { localProfileNames } from './prepare-all-profiles'

/** 同一个后端内按助手合并首次准备，并限制专家配置同步频率。 */
export class SharedProfileStartup {
  private prepared = new Set<string>()
  private pending = new Map<string, Promise<void>>()
  private syncedAt = new Map<string, number>()
  private generation = 0

  /** 账号目录来自主进程固定身份，API 由当前后端连接提供，不接收页面地址。 */
  constructor(
    private readonly options: {
      home: string
      appRoot: string
      drive: Pick<CloudDriveMcp, 'refresh'>
      interrupted: Pick<InterruptedTurns, 'claim'>
      refreshConnectors: (profile: string) => Promise<void>
      active: () => boolean
      log: (message: string) => void
      now?: () => number
    }
  ) {}

  /** 每次后端重启重新登记准备结果，旧轮次的迟到响应不能标记新后端。 */
  reset(prepared: ReadonlySet<string> = new Set()): void {
    this.generation++
    this.prepared = new Set(prepared)
    this.pending.clear()
    this.syncedAt.clear()
  }

  /** 删除或改名使旧档案失效；同名重建仍需准备，旧请求不能登记成功。 */
  forget(profile: string): void {
    this.prepared.delete(profile)
    this.pending.delete(profile)
    this.syncedAt.delete(profile)
  }

  /** 新助手先完成必要准备；已准备助手立即可用，专家同步异步进行。 */
  async ensure(profile: string, api: ProfileConfigApi): Promise<void> {
    if (!this.options.active()) {
      throw new Error('Account is no longer active')
    }

    const generation = this.generation
    let work = this.pending.get(profile)

    if (!this.prepared.has(profile) && !work) {
      if (profile !== 'default' && !localProfileNames(this.options.home, this.options.log).includes(profile)) {
        throw new Error('No such local profile')
      }

      // 先登记 Promise，再进入异步准备，重复请求只等待这一份工作。
      // 每次 API 调用前后复核轮次与档案；退出、恢复或删除后不继续写入。
      const guardedApi: ProfileConfigApi = async (method, route, body) => {
        if (generation !== this.generation || this.pending.get(profile) !== work || !this.options.active()) {
          throw new Error('Profile preparation was superseded')
        }

        const result = await api(method, route, body)

        if (generation !== this.generation || this.pending.get(profile) !== work || !this.options.active()) {
          throw new Error('Profile preparation was superseded')
        }

        return result
      }

      work = Promise.resolve()
        .then(() => this.prepare(profile, guardedApi))
        .then(() => {
          if (generation === this.generation && this.pending.get(profile) === work && this.options.active()) {
            this.prepared.add(profile)
            void this.options
              .refreshConnectors(profile)
              .catch(() => this.options.log('[profiles] connector refresh failed'))
          }
        })
        .finally(() => {
          if (this.pending.get(profile) === work) {
            this.pending.delete(profile)
          }
        })
      this.pending.set(profile, work)
    }

    await work

    if (generation !== this.generation || !this.options.active() || !this.prepared.has(profile)) {
      throw new Error('Profile preparation was superseded')
    }

    const now = (this.options.now ?? Date.now)()

    if (profile !== 'default' && now - (this.syncedAt.get(profile) ?? -Infinity) >= 60_000) {
      this.syncedAt.set(profile, now)
      void api('POST', '/api/plugins/uniwork-kits/expert-sync', { profile }).catch(() =>
        this.options.log(`[profiles] expert sync unavailable profile=${profile}`)
      )
    }
  }

  /** 运行中只复制插件文件与认领已退出写入者，所有配置变更均由原版 API 保存。 */
  private async prepare(profile: string, api: ProfileConfigApi): Promise<void> {
    // API 的轮次检查先于同步文件操作，避免退出或删档后的微任务重新复制插件。
    const saved = await api('GET', '/api/config?include_defaults=false')
    const home = profile === 'default' ? this.options.home : path.join(this.options.home, 'profiles', profile)
    const enabled = saved.plugins?.enabled ?? []
    const disabled = saved.plugins?.disabled ?? []

    if (!Array.isArray(enabled) || !Array.isArray(disabled)) {
      throw new Error('Invalid plugin configuration')
    }

    copyArtifactSharePlugin(home, this.options.appRoot)
    // 与启动前的会话标题安装一致：运行中新建的专家也要有标题扩展，并关闭原版付费命名。
    copyTitlePluginFiles(home, this.options.appRoot)
    this.options.interrupted.claim(home)

    const missing = ['desktop-deliverables', 'desktop-artifact-share', 'uniwork-titles'].filter(
      name => !enabled.includes(name) && !disabled.includes(name)
    )

    const patch: Record<string, unknown> = {}

    if (missing.length) {
      patch.plugins = { enabled: [...enabled, ...missing] }
    }

    if (saved.auxiliary?.title_generation?.enabled !== false) {
      patch.auxiliary = { title_generation: { enabled: false } }
    }

    if (Object.keys(patch).length) {
      await api('PUT', '/api/config', { config: patch })
    }

    await this.options.drive.refresh(profile, api)
  }
}
