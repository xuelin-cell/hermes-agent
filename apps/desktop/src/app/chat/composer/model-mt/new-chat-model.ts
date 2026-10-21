import { useEffect, useRef } from 'react'

import { getCurrentModelSource, setCurrentModelSource } from '@/store/session'

/** 只解除输入框手选标记，随后由原版刷新读取设置中的默认模型。 */
export function resetComposerModelForNewChat(): void {
  if (getCurrentModelSource() === 'manual') {
    setCurrentModelSource('default')
  }
}

/** 首次空白启动或从会话进入新对话时重置，同一草稿内重渲染不重置。 */
export function useResetComposerModelOnNewChat(activeSessionId: string | null, freshDraftReady: boolean): void {
  const wasFresh = useRef(false)
  // eslint-disable-next-line no-restricted-syntax -- 记录草稿是否已重置，不是镜像当前响应值；重连时必须保留此边沿状态。
  useEffect(() => {
    if (activeSessionId) {
      wasFresh.current = false
    } else if (freshDraftReady && !wasFresh.current) {
      wasFresh.current = true
      resetComposerModelForNewChat()
    }
  }, [activeSessionId, freshDraftReady])
}
