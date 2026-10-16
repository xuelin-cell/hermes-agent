import { useEffect, useRef, useState } from 'react'

import { DriveOperationError } from '@/api/drive'
import type { Translations } from '@/i18n/types'

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

  return copy.operationFailed
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
  async function run(action: () => Promise<unknown>, onSuccess: () => void): Promise<void> {
    if (gate.current.busy || !gate.current.mounted) {
      return
    }

    gate.current.busy = true
    setBusy(true)
    setFailure(null)

    try {
      await action()

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
