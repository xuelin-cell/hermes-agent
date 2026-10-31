import { useEffect } from 'react'

import { runNtfyInstruction } from '@/lib/ntfy-instructions'
import { openMessageCenterScope, receiveAnnouncement } from '@/store/message-center'

/**
 * 登录后自动订阅，退出或切账号立即断开：连接本身在主进程，
 * 这里只负责把公告写进消息中心、把指令交给刷新路由。
 */
export function useNtfySubscription(account: string | null): void {
  useEffect(() => {
    openMessageCenterScope(account)

    const bridge = account ? window.hermesDesktop?.ntfy : undefined

    if (!bridge) {
      return
    }

    const unsubscribe = bridge.onEvent(event => {
      switch (event.kind) {
        case 'announcement':
          receiveAnnouncement(event.announcement)

          break

        case 'instruction':
          // 刷新失败只影响这次指令，不能让异常中断后续消息。
          void runNtfyInstruction(event.instruction).catch(() => undefined)

          break

        default:
          // 连接状态只留在主进程日志里，页面不打扰用户。
          break
      }
    })

    void bridge.start().catch(() => undefined)

    return () => {
      unsubscribe()
      void bridge.stop().catch(() => undefined)
    }
  }, [account])
}
