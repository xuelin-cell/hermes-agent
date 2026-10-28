/**
 * 召唤东方财富专家时的连接器登录 — 数字员工 eastmoneySummonLogin 的 Hermes 版。
 *
 * 这几位专家的行情和财务数据走同事的东方财富连接器（OpenConnector）。连接器按档案各自授权，专家跟着
 * 通用助手（默认档案）那份走：后端 expert_sync 把通用助手的那条同步给专家；从专家对话打开的连接器页，
 * 配的也是通用助手。所以召唤时看通用助手连上没有，没连上就先弹窗问，问完之前召唤出来的问题发不出去。
 *
 * 「去连接」只打开连接器页里那张卡片的详情，授权由用户在那里点「连接」完成，这里不发起授权。之后每隔
 * 一会儿看一次状态；连上后让后端把连接器同步给这位专家、重载专家的 MCP，用户还停在连接器页就把他带回
 * 专家的对话。
 */

import { host } from '@hermes/plugin-sdk'
import { atom } from 'nanostores'

import { syncExpert } from './api'
import type { ExpertCard } from './types'

// 专家跟着通用助手那份连接器走，见模块说明。
const CONNECTOR_PROFILE = 'default'
// 连接器服务卡住时状态要等好几秒；过了这么久还没回来就先弹窗，别让人以为召唤没反应。
const PROMPT_DELAY_MS = 300
const WATCH_INTERVAL_MS = 2000
const WATCH_TIMEOUT_MS = 10 * 60 * 1000
// 宿主的「技能与工具」页（CAPABILITIES_ROUTE）；插件拿不到宿主的路由常量。
const CAPABILITIES_PATH = '/capabilities'

export interface ConnectorLoginPrompt {
  connectorId: string
  expert: ExpertCard
}

/** 查连接器状态：连上为 true，没连上为 false；本机没有连接器（连的是远程后端，或桌面太旧）时为 null。 */
export type ConnectorCheck = (id: string) => Promise<boolean | null>

interface LocalConnectorsDoor {
  getConnectionConfig?: (profile: string) => Promise<{ mode?: string }>
  localConnectors?: (input: {
    operation: 'list'
    profile: string
  }) => Promise<{ connectors: { id: string; connected: boolean }[] }>
}

/** 正在问用户要不要去连接的那一次；没有弹窗时为 null。 */
export const $connectorLoginPrompt = atom<ConnectorLoginPrompt | null>(null)

let generation = 0
let holding = false
let watching: AbortController | null = null

/** 通用助手那份连接器连上没有（和连接器页一样，只在本机后端时才有连接器）。 */
const connectedNow: ConnectorCheck = async id => {
  const desktop = (window as unknown as { hermesDesktop?: LocalConnectorsDoor }).hermesDesktop

  if (typeof desktop?.localConnectors !== 'function') {
    return null
  }

  if (desktop.getConnectionConfig && (await desktop.getConnectionConfig(CONNECTOR_PROFILE)).mode !== 'local') {
    return null
  }

  const result = await desktop.localConnectors({ operation: 'list', profile: CONNECTOR_PROFILE })

  return result.connectors.some(row => row.id === id && row.connected)
}

/** 弹窗还在、或者还没查完状态时为 true：召唤出来的新草稿先不能发。 */
export function connectorLoginBlocksSend(): boolean {
  return holding
}

/** 关掉弹窗（「稍后」、Esc 或换了别的专家）。召唤出来的问题可以发了，专家照旧用技能包里的脚本取数。 */
export function dismissConnectorLogin(): void {
  generation += 1
  holding = false
  $connectorLoginPrompt.set(null)
  watching?.abort()
  watching = null
}

/**
 * 让专家马上跟上通用助手刚连上的连接器：后端同步一次这位专家的配置，有变化才重载专家的 MCP
 * （重载会让这位专家已经开着的对话下一轮重新发完整上下文，所以没变化时不做）。
 */
export async function adoptConnector(expert: ExpertCard): Promise<void> {
  try {
    const { changes } = await syncExpert(expert.name)

    if (changes?.length) {
      await host.requestProfile(expert.profile, 'reload.mcp', { confirm: true }, undefined, {
        spawnPriority: 'foreground'
      })
    }
  } catch {
    // 专家后端下次启动时还会同步一次。
  }
}

/**
 * 召唤时调用：这位专家要的连接器还没连上，就先弹窗问；问完之前召唤出来的问题发不出去。状态拿不到
 * （连接器服务出错）也照样问。已经连上就顺手让专家跟上（通用助手是在专家后端启动之后才连上的情况）。
 */
export async function offerConnectorLogin(expert: ExpertCard, check: ConnectorCheck = connectedNow): Promise<void> {
  dismissConnectorLogin()

  const id = expert.required_connector

  if (!id) {
    return
  }

  const mine = generation
  holding = true

  const show = () => {
    if (mine === generation) {
      $connectorLoginPrompt.set({ connectorId: id, expert })
    }
  }

  const timer = setTimeout(show, PROMPT_DELAY_MS)
  let connected: boolean | null = false

  try {
    connected = await check(id)
  } catch {
    // 状态不明：照样问，让用户自己决定。
  }

  clearTimeout(timer)

  if (mine !== generation) {
    return
  }

  if (connected === false) {
    show()

    return
  }

  holding = false
  $connectorLoginPrompt.set(null)

  if (connected) {
    void adoptConnector(expert)
  }
}

export interface ConnectorWatchOptions {
  check?: ConnectorCheck
  intervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}

/** 每隔一会儿看一次连接器连上没有：连上返回 true；超时、取消或本机没有连接器时返回 false。 */
export async function watchUntilConnected(id: string, options: ConnectorWatchOptions = {}): Promise<boolean> {
  const { check = connectedNow, intervalMs = WATCH_INTERVAL_MS, signal, timeoutMs = WATCH_TIMEOUT_MS } = options
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const started = Date.now()

  while (!signal?.aborted && Date.now() - started < timeoutMs) {
    try {
      const connected = await check(id)

      if (connected) {
        return true
      }

      if (connected === null) {
        return false
      }
    } catch {
      // 授权页还开着时状态偶尔拿不到，接着等。
    }

    await sleep(intervalMs)
  }

  return false
}

/** 连接器页里直接打开某个推荐连接器详情的地址（连接器页认 recommended 参数）。 */
export function connectorDetailPath(connectorId: string): string {
  return `${CAPABILITIES_PATH}?tab=connectors&recommended=${encodeURIComponent(connectorId)}`
}

/**
 * 弹窗里的「去连接」：打开连接器页里这个连接器的详情，用户在那里点「连接」。之后盯着状态，最多 10 分钟；
 * 连上时用户还停在连接器页，就调 onReady 把他带回专家（召唤时传的是重新召唤这位专家）；已经离开了，
 * 只让专家跟上，不打断他正在看的页面。
 */
export function goToConnector(onReady: (expert: ExpertCard) => void, check: ConnectorCheck = connectedNow): void {
  const prompt = $connectorLoginPrompt.get()

  if (!prompt) {
    return
  }

  dismissConnectorLogin()
  host.navigate(connectorDetailPath(prompt.connectorId))

  watching?.abort()
  const watch = new AbortController()
  watching = watch

  void watchUntilConnected(prompt.connectorId, { check, signal: watch.signal }).then(connected => {
    if (!connected || watch.signal.aborted) {
      return
    }

    if (window.location.hash.startsWith(`#${CAPABILITIES_PATH}`)) {
      onReady(prompt.expert)
    } else {
      void adoptConnector(prompt.expert)
    }
  })
}
