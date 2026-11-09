import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'

import { cloudTransferSession, type TransferInput } from './cloud-transfer-session'

/** 页面仅观察窗口任务；产物上传由共享控制器继续执行，结果不借用其他发起页面。 */
export function useCloudTransfer(onUploaded: () => void) {
  const { t } = useI18n()
  const session = cloudTransferSession()
  const state = useStore(session.state)
  const [owner] = useState(() => Symbol('cloud-transfer-view'))
  const mounted = useRef(false)
  const seenUpload = useRef(state.uploadRevision)

  // 记录观察者生命周期，后台任务不由页面卸载取消。
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    mounted.current = true
    session.acquire(owner)

    return () => {
      mounted.current = false
      session.release(owner)
    }
  }, [owner, session])

  // 修订号是一次性通知游标，不是用于渲染的状态镜像。
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (seenUpload.current !== state.uploadRevision) {
      seenUpload.current = state.uploadRevision
      onUploaded()
    }
  }, [onUploaded, state.uploadRevision])

  /** 等待时捕获发起视图，已卸载视图不再拿迟到结果打开预览或刷新自身。 */
  async function start(input: TransferInput, displayName?: string) {
    const result = await session.start(owner, input, displayName, t)

    return mounted.current ? result : undefined
  }

  return {
    busy: state.busy,
    cancelling: state.cancelling,
    cancel: () => session.cancel(),
    progress: state.owner === owner ? state.progress : null,
    result: state.owner === owner ? state.result : null,
    start,
    records: state.records,
    popupOpen: state.popupOpen,
    setPopupOpen: (open: boolean) => session.setPopupOpen(open),
    clearFinished: () => session.clearFinished()
  }
}
