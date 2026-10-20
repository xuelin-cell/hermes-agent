import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useState } from 'react'

import { $apiRequestScope } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Share2 } from '@/lib/icons'

import { ArtifactShareDialog, type ArtifactShareTarget } from './share-dialog'

/** 预览工具栏只提供一个分享入口；创建链接和管理操作统一进入对话框。 */
export function ShareControls(target: ArtifactShareTarget) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [publishable, setPublishable] = useState(false)
  const scope = useStore($apiRequestScope)
  const { sessionId, path, content } = target.source
  const bridge = window.hermesDesktop
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    let active = true
    let generation = 0
    setPublishable(false)
    setOpen(false)

    /** 来源改变时重新查询资格，迟到响应不进入新上下文。 */
    function refresh(): void {
      const request = ++generation
      void bridge.artifactShare
        .eligibility({ sessionId, path, content })
        .then(result => {
          if (active && request === generation) {
            setPublishable(result.publishable)
          }
        })
        .catch(() => {
          if (active && request === generation) {
            setPublishable(false)
          }
        })
    }

    refresh()
    const unsubscribe = bridge.artifactShare.onChanged(refresh)

    return () => {
      active = false
      unsubscribe()
    }
  }, [target.artifactKey, sessionId, path, content, scope, bridge])

  return (
    <>
      <Tip label={publishable ? t.artifactShare.shareArtifact : t.artifactShare.originRequired}>
        <span className="inline-flex">
          <Button
            aria-label={t.artifactShare.shareArtifact}
            disabled={!publishable}
            onClick={() => setOpen(true)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Share2 aria-hidden="true" />
          </Button>
        </span>
      </Tip>
      {open && <ArtifactShareDialog {...target} onClose={close} />}
    </>
  )
}
