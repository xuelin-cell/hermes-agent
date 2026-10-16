import { useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { notify } from '@/store/notifications'

import type {
  CloudDriveArtifactSource,
  CloudDriveTransferProgress,
  CloudDriveTransferRequest,
  CloudDriveTransferResult
} from '../../../electron/login/contract'

import { driveTransferFailure } from './cloud-transfer-copy'
import { useCloudTransferHistory } from './use-cloud-transfer-history'

type TransferInput =
  | { operation: 'upload'; parentAssetId: string; artifact?: CloudDriveArtifactSource }
  | { operation: 'download' | 'preview'; assetId: string; name: string; size?: number | null }
  | { operation: 'download-many'; assets: Array<{ assetId: string; name: string; size?: number | null }> }

interface ActiveTransfer {
  id: string
  operation: TransferInput['operation']
  sawProgress: boolean
  cancelRequested: boolean
}

/** 传输状态只属于当前页面，结果通过传输浮窗和共享通知展示，不占用文件列表空间。 */
export function useCloudTransfer(onUploaded: () => void) {
  const { t } = useI18n()
  const copy = t.cloudLibrary
  const history = useCloudTransferHistory()
  const updateHistory = history.progress
  const active = useRef<ActiveTransfer | null>(null)
  const mounted = useRef({ active: true })
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [progress, setProgress] = useState<CloudDriveTransferProgress | null>(null)
  const [result, setResult] = useState<CloudDriveTransferResult | null>(null)

  useEffect(() => {
    const lifecycle = mounted.current
    lifecycle.active = true

    const dispose = window.hermesDesktop?.onCloudDriveProgress?.(value => {
      if (lifecycle.active && value.id === active.current?.id) {
        if (!value.fileStatus) {
          active.current.sawProgress = true
        }

        setProgress(value)

        if (active.current?.operation !== 'preview') {
          updateHistory(value)
        }
      }
    })

    return () => {
      lifecycle.active = false
      dispose?.()

      if (active.current) {
        void Promise.resolve(window.hermesDesktop?.cancelCloudDriveTransfer?.(active.current.id)).catch(() => {})
      }
    }
  }, [updateHistory])

  /** 停止接口失联时保留活动任务并恢复停止按钮，不把请求失败当成已取消。 */
  function cancelFailed(context: ActiveTransfer): void {
    if (mounted.current.active && active.current === context) {
      context.cancelRequested = false
      setCancelling(false)
      notify({ kind: 'error', title: copy.transfers, message: copy.transferStopFailed })
    }
  }

  /** 停止只发送一次取消请求，原生端结束前不解锁；取消请求失败允许再次尝试。 */
  function cancel(): void {
    const context = active.current

    if (!context || context.cancelRequested) {
      return
    }

    context.cancelRequested = true
    setCancelling(true)
    const request = window.hermesDesktop?.cancelCloudDriveTransfer

    if (!request) {
      cancelFailed(context)

      return
    }

    try {
      void Promise.resolve(request(context.id)).catch(() => cancelFailed(context))
    } catch {
      cancelFailed(context)
    }
  }

  /** 结果通知使用源版本文件名和场景文案，预览成功不冒充保存成功。 */
  function announce(input: TransferInput, value: CloudDriveTransferResult): void {
    if (value.status === 'succeeded' && value.preview) {
      return
    }

    const operation = input.operation === 'download-many' ? 'download' : input.operation
    let message: string

    if (value.status === 'succeeded') {
      message =
        input.operation === 'upload'
          ? copy.uploadSaved(value.name)
          : input.operation === 'download-many'
            ? copy.downloadsSaved(
                value.files?.filter(file => file.status === 'succeeded').length ?? input.assets.length,
                value.files?.filter(file => file.status === 'cancelled').length ?? 0
              )
            : copy.downloadSaved(value.name)
    } else if (value.status === 'cancelled') {
      message = operation === 'upload' ? copy.transferUploadStopped : copy.transferCancelled
    } else {
      message = driveTransferFailure(value.status, value.code, operation, copy)
    }

    notify({
      id: `drive-transfer-${active.current?.id}`,
      title: copy.transfers,
      message,
      kind:
        value.status === 'succeeded'
          ? 'success'
          : value.status === 'cancelled'
            ? 'info'
            : value.status === 'failed'
              ? 'error'
              : 'warning'
    })
  }

  /** 原生端选择路径及鉴权；关闭浮窗不取消，离页才终止尚未完成的传输。 */
  async function start(input: TransferInput, displayName?: string): Promise<CloudDriveTransferResult | undefined> {
    if (active.current) {
      return
    }

    const context = { id: crypto.randomUUID(), operation: input.operation, sawProgress: false, cancelRequested: false }
    active.current = context
    const request = { ...input, id: context.id } as CloudDriveTransferRequest
    history.begin(request, displayName || copy.upload)
    setBusy(true)
    setCancelling(false)
    setResult(null)
    setProgress(null)

    try {
      if (!window.hermesDesktop?.cloudDriveTransfer) {
        throw new Error('Bridge unavailable')
      }

      const value = await window.hermesDesktop.cloudDriveTransfer(request)

      if (!mounted.current.active) {
        return
      }

      setResult(value)

      const silent =
        value.status === 'cancelled' &&
        !context.sawProgress &&
        !context.cancelRequested &&
        !value.files?.some(file => file.status === 'succeeded')

      if (input.operation !== 'preview') {
        history.finish(context.id, value, silent)
      }

      if (!silent) {
        announce(input, value)
      }

      if (input.operation === 'upload' && !silent) {
        onUploaded()
      }

      return value
    } catch {
      if (mounted.current.active) {
        const failure = {
          protocol: 'uniwork.drive-result.v1',
          ok: false,
          status: input.operation === 'upload' ? 'outcome_unknown' : 'failed',
          code: 'IPC_ERROR'
        } as const

        setResult(failure)

        if (input.operation !== 'preview') {
          history.finish(context.id, failure)
        }

        announce(input, failure)

        if (input.operation === 'upload') {
          onUploaded()
        }
      }
    } finally {
      active.current = null

      if (mounted.current.active) {
        setBusy(false)
        setCancelling(false)
      }
    }
  }

  return {
    busy,
    cancelling,
    cancel,
    progress,
    result,
    start,
    records: history.records,
    popupOpen: history.open,
    setPopupOpen: history.setOpen,
    clearFinished: history.clearFinished
  }
}
