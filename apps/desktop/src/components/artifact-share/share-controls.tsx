import type { ArtifactShareSource } from '@hermes/shared/artifact-share'
import { useCallback, useEffect, useRef, useState } from 'react'

import { $apiRequestScope } from '@/api/client'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { PopoverContent } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ExternalLink, RefreshCw, Share2, Trash2 } from '@/lib/icons'
import { notify, notifyError } from '@/store/notifications'

interface ShareRecord {
  key: string
  hash: string
  shareId: string
  url: string
  version: number
}

interface ArtifactShareListAction {
  onOpen: () => void
  onClose: () => void
}

interface ShareControlsProps {
  artifactKey: string
  html: string | (() => Promise<string> | string)
  title: string
  source: ArtifactShareSource
  sourceText?: string
  /** 资料库首次点击只发布，已发布产物才打开链接操作。 */
  listAction?: ArtifactShareListAction
}

/** 将当前产物发布为静态快照，并展示同一产物已保存的链接。 */
export function ShareControls({ artifactKey, html, title, source, sourceText, listAction }: ShareControlsProps) {
  const { t } = useI18n()
  const copy = t.artifactShare
  const [savedRecord, setRecord] = useState<ShareRecord | null>(null)
  const record = savedRecord?.key === artifactKey ? savedRecord : null
  const [busy, setBusy] = useState(false)
  const [publishable, setPublishable] = useState(false)
  const { sessionId, path, content } = source
  const [ready, setReady] = useState(false)
  const requested = useRef({ started: false, existing: false })
  const lifecycle = useRef({ active: false, busy: false, generation: 0 })

  useEffect(() => {
    const owner = lifecycle.current
    owner.active = true
    owner.busy = false
    owner.generation += 1

    return () => {
      owner.active = false
      owner.generation += 1
    }
  }, [artifactKey, sessionId, path, content])

  /** 发布始终来自明确点击；读取与散列期间切换来源或账号就停止。 */
  const publish = useCallback(async () => {
    const owner = lifecycle.current
    const generation = owner.generation
    const bridge = window.hermesDesktop
    const scope = $apiRequestScope.get()

    /** 迟到的结果不进入新账号或已关闭的工具栏。 */
    const current = () =>
      owner.active &&
      owner.generation === generation &&
      window.hermesDesktop === bridge &&
      $apiRequestScope.get() === scope

    if (owner.busy || !current()) {
      return
    }

    owner.busy = true
    setBusy(true)

    try {
      const snapshot = typeof html === 'function' ? await html() : html
      const bytes = new TextEncoder().encode(sourceText ?? snapshot)
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')

      if (!current()) {
        return
      }

      const next = await bridge.artifactShare.publish({
        key: artifactKey,
        html: snapshot,
        title,
        source: { sessionId, path, content, ...(path ? { hash } : {}) }
      })

      if (current()) {
        setRecord(next)
        notify({ kind: 'success', title: copy.publishSucceeded, message: title })

        if (!requested.current.existing) {
          listAction?.onClose()
        }
      }
    } catch (error) {
      if (current()) {
        notifyError(error, copy.shareFailed)

        if (!requested.current.existing) {
          listAction?.onClose()
        }
      }
    } finally {
      if (current()) {
        owner.busy = false
        setBusy(false)
      }
    }
  }, [
    artifactKey,
    html,
    title,
    sourceText,
    sessionId,
    path,
    content,
    copy.publishSucceeded,
    copy.shareFailed,
    listAction
  ])

  useEffect(() => {
    let active = true
    let generation = 0

    /** 工具或其他预览入口改变链接后，从主进程重新读取权威记录。 */
    const refresh = () => {
      const current = ++generation

      const api = window.hermesDesktop.artifactShare
      void Promise.all([api.inspect(artifactKey), api.eligibility({ sessionId, path, content })])
        .then(([found, eligibility]) => {
          if (active && current === generation) {
            setRecord(found)
            setPublishable(eligibility.publishable)
            setReady(true)
          }
        })
        .catch(error => {
          if (active && current === generation) {
            if (listAction) {
              notifyError(error, copy.shareFailed)
              listAction.onClose()
            }

            setRecord(null)
            setPublishable(false)
            setReady(false)
          }
        })
    }

    setReady(false)
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
  }, [artifactKey, sessionId, path, content, listAction, copy.shareFailed])

  useEffect(() => {
    if (listAction && ready && !requested.current.started) {
      requested.current.started = true

      if (record) {
        requested.current.existing = true
        listAction.onOpen()
      } else if (publishable) {
        void publish()
      } else {
        notifyError(new Error(copy.originRequired), copy.shareFailed)
        listAction.onClose()
      }
    } else if (listAction && ready && requested.current.existing && !record) {
      listAction.onClose()
    }
  }, [listAction, ready, record, publishable, publish, copy.originRequired, copy.shareFailed])

  /** 网关确认撤销后才移除当前链接。 */
  const revoke = async () => {
    setBusy(true)

    try {
      await window.hermesDesktop.artifactShare.revoke(artifactKey)
      setRecord(null)
      listAction?.onClose()
    } catch (error) {
      notifyError(error, copy.revokeFailed)
    } finally {
      setBusy(false)
    }
  }

  // 资料库展开栏只承载已发布链接；撤销后即使关闭动画未结束，也不展示单独的分享按钮。
  if (listAction && !record) {
    return null
  }

  const controls = (
    <div className="flex flex-wrap items-center gap-1">
      <Tip label={publishable ? (record ? copy.updateShared : copy.shareArtifact) : copy.originRequired}>
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
                  void window.hermesDesktop
                    .openExternal(record.url)
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
              <Trash2 aria-hidden="true" />
            </Button>
          </Tip>
        </>
      )}
    </div>
  )

  return listAction ? (
    <PopoverContent align="end" aria-label={copy.shareArtifact} className="w-auto max-w-[calc(100vw-2rem)]">
      <div aria-label={copy.shareArtifact} role="toolbar">
        {controls}
      </div>
    </PopoverContent>
  ) : (
    controls
  )
}
