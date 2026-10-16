import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { type ConversationShareDependencies, ConversationShareService } from './service'

/** 会话分享只向可信聊天窗口暴露固定能力，预览 guest 不能调用发布接口。 */
export function installConversationShareIpc(
  ipc: IpcMain,
  authorize: (event: IpcMainInvokeEvent) => void,
  dependencies: ConversationShareDependencies
): void {
  const service = new ConversationShareService(dependencies)
  ipc.handle('hermes:conversation-share:prepare', (event, owner, request) => {
    authorize(event)

    return service.prepare(owner, request)
  })
  ipc.handle('hermes:conversation-share:publish', (event, ticket, html) => {
    authorize(event)

    return service.publish(ticket, html)
  })
  ipc.handle('hermes:conversation-share:image', (event, ticket, reference) => {
    authorize(event)

    return service.image(ticket, reference)
  })
  ipc.handle('hermes:conversation-share:cancel', (event, ticket) => {
    authorize(event)
    service.cancel(ticket)
  })
  ipc.handle('hermes:conversation-share:list', (event, owner, sessionId) => {
    authorize(event)

    return service.list(owner, sessionId)
  })
  ipc.handle('hermes:conversation-share:revoke', (event, key) => {
    authorize(event)

    return service.revoke(key)
  })
}
