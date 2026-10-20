import { ipcMain, type Session } from 'electron'

import { isDesktopRendererSender } from '../desktop-renderer-sender'

import type { PreparedLocalContext } from './runtime-context'
import { createUniAgentGateReconnect } from './uniagentgate-control'

/** 仅当前账号主页面可请求个人 5G 重连，命名 Profile 不回退到默认账号。 */
export function installUniAgentGateIpc(
  session: Session,
  rendererUrl: () => string,
  readContext: () => PreparedLocalContext | null
): void {
  const reconnect = createUniAgentGateReconnect(readContext)
  ipcMain.handle('hermes:uniagentgate:reconnect', (event, ...args) => {
    if (!isDesktopRendererSender(event, session, rendererUrl()) || args.length > 1 ||
        (args[0] !== undefined && args[0] !== 'default')) {
      return { status: 'unavailable' }
    }

    return reconnect()
  })
}
