import { useEffect, useRef, useState } from 'react'

import type { DriveAsset } from '@/api/drive'
import { NEW_CHAT_ROUTE, sessionRoute } from '@/app/routes'
import { useI18n } from '@/i18n'

import { addCloudReference } from './drive-chat-reference'

/** 资料库只负责加入草稿，聊天导航继续交给外层路由，绝不触发提交。 */
export function useCloudDraft(onReady?: (route: string) => void) {
  const { t } = useI18n()
  const lifecycle = useRef({ active: true, busy: false })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const state = lifecycle.current
    state.active = true

    return () => {
      state.active = false
    }
  }, [])

  /** 探测期间锁住重复点击，离页或切换上下文后不再写入草稿。 */
  async function add(asset: DriveAsset | readonly DriveAsset[]) {
    const state = lifecycle.current

    if (state.busy) {
      return
    }

    state.busy = true
    setBusy(true)
    setMessage('')

    try {
      const result = await addCloudReference(asset, () => state.active)

      if (!state.active) {
        return
      }

      if (result.status === 'added') {
        setMessage(t.cloudLibrary.draftAdded)
        onReady?.(result.sessionId ? sessionRoute(result.sessionId) : NEW_CHAT_ROUTE)
      } else {
        setMessage(
          result.status === 'remote'
            ? t.cloudLibrary.draftRemote
            : result.status === 'changed'
              ? t.cloudLibrary.draftChanged
              : result.status === 'notReady'
                ? t.cloudLibrary.draftNotReady
                : t.cloudLibrary.draftUnavailable
        )
      }
    } finally {
      state.busy = false

      if (state.active) {
        setBusy(false)
      }
    }
  }

  return { add, busy, message }
}
