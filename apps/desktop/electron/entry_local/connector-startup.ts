import type { ConnectorManager } from '../open-connector/manager'

/** 立即预热连接器，返回后端就绪后的刷新动作；两个等待互不阻塞桌面启动。 */
export function startAccountConnectors(options: {
  connectors: Pick<ConnectorManager, 'start' | 'refreshAll'>
  active: () => boolean
  log: (message: string) => void
}): () => Promise<void> {
  const ready = options.connectors.start().then(
    () => true,
    () => {
      options.log('[connectors] background startup failed')

      return false
    }
  )

  /** 只有当前账号和当前后端启动仍有效时才刷新；失败只记日志，不拉起另一份后端。 */
  return async function refreshAfterBackendReady(): Promise<void> {
    if (!(await ready) || !options.active()) {
      return
    }

    try {
      await options.connectors.refreshAll()
    } catch {
      options.log('[connectors] background config refresh failed')
    }
  }
}
