import type { ArtifactShareSource } from '@hermes/shared/artifact-share'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ExternalLink, RefreshCw, Share2, X } from '@/lib/icons'
import { notifyError } from '@/store/notifications'

interface ShareRecord {
  key: string
  hash: string
  shareId: string
  url: string
  version: number
}

interface ShareControlsProps {
  artifactKey: string
  html: string | (() => Promise<string> | string)
  title: string
  source: ArtifactShareSource
  sourceText?: string
}

/** 将当前产物发布为静态快照，并展示同一产物已保存的链接。 */
export function ShareControls({ artifactKey, html, title, source, sourceText }: ShareControlsProps) {
  const { t } = useI18n()
  const copy = t.artifactShare
  const [savedRecord, setRecord] = useState<ShareRecord | null>(null)
  const record = savedRecord?.key === artifactKey ? savedRecord : null
  const [busy, setBusy] = useState(false)
  const [publishable, setPublishable] = useState(false)
  const { sessionId, path, content } = source

  useEffect(() => {
    let active = true
    let generation = 0

    /** 工具或其他预览入口改变链接后，从主进程重新读取权威记录。 */
    const refresh = () => {
      const current = ++generation

      void window.hermesDesktop.artifactShare
        .inspect(artifactKey)
        .then(found => {
          if (active && current === generation) {
            setRecord(found)
          }
        })
        .catch(() => {
          if (active && current === generation) {
            setRecord(null)
          }
        })
      void window.hermesDesktop.artifactShare.eligibility({ sessionId, path, content })
        .then(result => {
          if (active && current === generation) {
            setPublishable(result.publishable)
          }
        })
        .catch(() => {
          if (active && current === generation) {
            setPublishable(false)
          }
        })
    }

    refresh()

    const unsubscribe = window.hermesDesktop.artifactShare.onChanged(key => {
      if (key === artifactKey || key === '*') {
        refresh()
      }
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [artifactKey, sessionId, path, content])

  /** 仅在用户点击时发布，更新沿用原链接。 */
  const publish = async () => {
    setBusy(true)

    try {
      const snapshot = typeof html === 'function' ? await html() : html
      const bytes = new TextEncoder().encode(sourceText ?? snapshot)
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')

      const next = await window.hermesDesktop.artifactShare.publish({
        key: artifactKey, html: snapshot, title, source: { sessionId, path, content, ...(path ? { hash } : {}) }
      })

      setRecord(next)
    } catch (error) {
      notifyError(error, copy.shareFailed)
    } finally {
      setBusy(false)
    }
  }

  /** 网关确认撤销后才移除当前链接。 */
  const revoke = async () => {
    setBusy(true)

    try {
      await window.hermesDesktop.artifactShare.revoke(artifactKey)
      setRecord(null)
    } catch (error) {
      notifyError(error, copy.revokeFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Tip label={publishable ? record ? copy.updateShared : copy.shareArtifact : copy.originRequired}>
        <span className="inline-flex">
          <Button
            aria-label={record ? copy.updateShared : copy.shareArtifact}
            disabled={busy || !publishable}
            loading={busy}
            onClick={() => void publish()}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            {record ? <RefreshCw aria-hidden="true" /> : <Share2 aria-hidden="true" />}
          </Button>
        </span>
      </Tip>
      {record && (
        <>
          <CopyButton appearance="icon" buttonSize="icon-xs" label={copy.copyShared} text={record.url} />
          <Tip label={copy.viewShared}>
            <Button asChild size="icon-xs" variant="ghost">
              <a
                aria-label={copy.viewShared}
                href={record.url}
                onClick={event => {
                  event.preventDefault()
                  void window.hermesDesktop.openExternal(record.url)
                    .catch(error => notifyError(error, t.artifactPreview.openInBrowserFailed))
                }}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          </Tip>
          <Tip label={copy.revokeShared}>
            <Button
              aria-label={copy.revokeShared}
              disabled={busy}
              onClick={() => void revoke()}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" />
            </Button>
          </Tip>
        </>
      )}
    </div>
  )
}
