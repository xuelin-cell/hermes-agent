import type { IpcMainInvokeEvent } from 'electron'

import type { AsrIdentity, AsrRequest } from './contract'
import { UniworkAsrSession } from './session'

/** 同一桌面只持有一个识别连接，所有请求与创建它的主框架绑定。 */
export function createUniworkAsrHandler(readIdentity: () => AsrIdentity | null) {
  let active: { owner: number; session: UniworkAsrSession } | null = null

  return async (event: IpcMainInvokeEvent, request: AsrRequest): Promise<unknown> => {
    if (request?.operation === 'start') {
      if (!['zh', 'en'].includes(request.language)) {
        throw new Error('语音识别语言无效。')
      }

      const identity = readIdentity()

      if (!identity || identity.expiresAt <= Date.now() || !identity.key) {
        throw new Error('语音识别需要有效的元景套餐，请重新登录后重试。')
      }

      if (active && !active.session.isClosed) {
        throw new Error('另一处正在使用语音识别，请先停止。')
      }

      const session = new UniworkAsrSession(identity, readIdentity)
      active = { owner: event.sender.id, session }

      /** 仅撤销此窗口创建的连接，旧窗口的销毁不能关闭新连接。 */
      const dispose = () => {
        session.cancel()

        if (active?.session === session) {
          active = null
        }
      }

      event.sender.once('destroyed', dispose)
      event.sender.once('render-process-gone', dispose)

      /** 主框架离开桌面时立即停止麦克风上游传输。 */
      const navigate = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => {
        if (mainFrame) {
          dispose()
        }
      }

      event.sender.on('did-start-navigation', navigate)
      session.onClosed(() => {
        event.sender.removeListener('destroyed', dispose)
        event.sender.removeListener('render-process-gone', dispose)
        event.sender.removeListener('did-start-navigation', navigate)
      })

      try {
        await session.open(request.language)

        return session.id
      } catch (error) {
        dispose()
        throw error
      }
    }

    if (!active || active.owner !== event.sender.id || active.session.id !== request?.id) {
      throw new Error('语音识别会话已结束。')
    }

    const session = active.session

    switch (request.operation) {
      case 'audio':
        session.audio(request.pcm)

        return

      case 'poll':
        return session.poll()

      case 'stop':
        return session.stop()

      case 'cancel':
        session.cancel()

        return

      default:
        throw new Error('语音识别请求无效。')
    }
  }
}
