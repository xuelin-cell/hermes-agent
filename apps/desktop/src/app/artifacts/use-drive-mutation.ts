import { useEffect, useRef, useState } from 'react'

import { DriveOperationError } from '@/api/drive'
import { translateNow } from '@/i18n'
import type { Translations } from '@/i18n/types'
import { dismissNotification, notify } from '@/store/notifications'

/** 用服务明确返回的状态选择提示，未知结果要求先刷新查看，不能再次提交。 */
export function driveMutationMessage(failure: unknown, copy: Translations['cloudLibrary']): string {
  if (failure instanceof DriveOperationError) {
    if (failure.status === 'outcome_unknown') {
      return copy.operationUnknown
    }

    if (failure.status === 'partial_success') {
      return copy.operationPartial
    }
  }

  return failure instanceof DriveOperationError
    ? copy.transferErrors[failure.code] || copy.operationFailed
    : copy.operationFailed
}

/** 只有主进程真正启动核验才显示临时提示，结束即移除，不留下长期待确认状态。 */
export async function runVerifiedDriveMutation<T>(
  action: (verifying: () => void) => Promise<T>,
  active = () => true
): Promise<T> {
  let notice: string | undefined

  try {
    return await action(() => {
      if (active()) {
        notice = notify({
          id: notice,
          kind: 'info',
          title: translateNow('cloudLibrary.transfers'),
          message: translateNow('cloudLibrary.operationVerifying'),
          durationMs: 0
        })
      }
    })
  } finally {
    if (notice) {
      dismissNotification(notice)
    }
  }
}

/** 无法确认不是明确失败，不使用红色错误通知。 */
export function notifyDriveMutationFailure(failure: unknown, title: string, copy: Translations['cloudLibrary']): void {
  notify({
    title,
    message: driveMutationMessage(failure, copy),
    kind: failure instanceof DriveOperationError && failure.status !== 'failed' ? 'warning' : 'error'
  })
}

/** 锁住一次用户确认的写操作，组件卸载后不再更新页面或触发导航。 */
export function useDriveMutation() {
  const gate = useRef({ busy: false, mounted: true })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)

  useEffect(() => {
    const lifecycle = gate.current
    lifecycle.mounted = true

    return () => {
      lifecycle.mounted = false
    }
  }, [])

  /** 只执行一次请求；部分成功和结果未知均不会进入成功回调。 */
  async function run(action: (verifying: () => void) => Promise<unknown>, onSuccess: () => void): Promise<void> {
    if (gate.current.busy || !gate.current.mounted) {
      return
    }

    gate.current.busy = true
    setBusy(true)
    setFailure(null)

    try {
      await runVerifiedDriveMutation(action, () => gate.current.mounted)

      if (gate.current.mounted) {
        onSuccess()
      }
    } catch (error) {
      if (gate.current.mounted) {
        setFailure(error)
      }
    } finally {
      gate.current.busy = false

      if (gate.current.mounted) {
        setBusy(false)
      }
    }
  }

  return {
    busy,
    failure,
    run,
    uncertain: failure instanceof DriveOperationError && failure.status !== 'failed'
  }
}
