import { atom, onMount } from 'nanostores'

import type { MessagingOperationStatus } from '../../../electron/entry_local/messaging-contract'

export const $messagingOperation = atom<MessagingOperationStatus>({ phase: 'idle', revision: -1 })

/** 只记住用户关闭的操作提示；主进程失败记录和实时渠道状态保持原样。 */
export const $dismissedMessagingFailureRevision = atom(-1)

/** 页面只订阅状态，主进程继续任务；返回页面时补取快照，不重新执行操作。 */
onMount($messagingOperation, () => {
  let active = true

  /** 先订阅后补取，避免迟到快照覆盖操作的新阶段。 */
  function update(status: MessagingOperationStatus): void {
    if (active && status.revision >= $messagingOperation.get().revision) {
      $messagingOperation.set(status)
    }
  }

  const bridge = window.hermesDesktop
  const off = bridge.onMessagingStatus(update)
  void bridge.messagingStatus().then(update).catch(() => undefined)

  return () => {
    active = false
    off()
  }
})
