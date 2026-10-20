import { artifactShareActive, type ArtifactShareRecord, type ArtifactShareSource } from '@hermes/shared/artifact-share'
import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { $apiRequestScope } from '@/api/client'
import { writeClipboardText } from '@/components/ui/copy-button'
import { useI18n } from '@/i18n'
import { notify } from '@/store/notifications'

import { ArtifactShareDialogView } from './share-dialog-view'

export interface ArtifactShareTarget {
  artifactKey: string
  html: string | (() => Promise<string> | string)
  title: string
  source: ArtifactShareSource
  sourceText?: string
}

interface ArtifactShareDialogProps extends ArtifactShareTarget {
  onClose: () => void
}

interface PreparedArtifactShare {
  html: string
  hash: string
  sourceHash: string
}

/** 区分公开快照和源文件的指纹，更新确认与来源复核各用对应内容。 */
async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** 弹窗只准备和检查状态；发布、更新及撤销均等待用户在弹窗中确认。 */
export function ArtifactShareDialog({
  artifactKey,
  html,
  title,
  source,
  sourceText,
  onClose
}: ArtifactShareDialogProps) {
  const { t } = useI18n()
  const copy = t.artifactShare
  const scope = useStore($apiRequestScope)
  const initialScope = useRef(scope)
  const bridge = window.hermesDesktop
  const { sessionId, path, content } = source
  const latest = useRef({ html, sourceText })
  latest.current = { html, sourceText }
  const [record, setRecord] = useState<ArtifactShareRecord | null>(null)
  const [prepared, setPrepared] = useState<PreparedArtifactShare | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const owner = useRef({ active: false, generation: 0, busy: false })
  const literalHtml = typeof html === 'string' ? html : null

  /** A→B→A 的上下文往返同样使原操作失效，不向新账号写入迟到结果。 */
  function current(generation: number): boolean {
    return (
      owner.current.active &&
      owner.current.generation === generation &&
      $apiRequestScope.get() === scope &&
      window.hermesDesktop === bridge
    )
  }

  useEffect(() => {
    if (scope !== initialScope.current) {
      onClose()

      return
    }

    const lifecycle = owner.current
    lifecycle.active = true
    lifecycle.busy = false
    const generation = ++lifecycle.generation
    let active = true
    setLoading(true)
    setBusy(false)
    setError('')
    setPrepared(null)

    /** 原生记录权威、快照只读；关闭或切换来源后丢弃全部准备结果。 */
    async function prepare(): Promise<void> {
      try {
        const [found, eligibility] = await Promise.all([
          bridge.artifactShare.inspect(artifactKey),
          bridge.artifactShare.eligibility({ sessionId, path, content })
        ])

        if (!active || lifecycle.generation !== generation || $apiRequestScope.get() !== scope) {
          return
        }

        setRecord(found)

        if (eligibility.publishable) {
          const target = latest.current
          const snapshot = typeof target.html === 'function' ? await target.html() : target.html
          const [hash, sourceHash] = await Promise.all([digest(snapshot), digest(target.sourceText ?? snapshot)])

          if (active && lifecycle.generation === generation && $apiRequestScope.get() === scope) {
            setPrepared({ html: snapshot, hash, sourceHash })
          }
        }
      } catch (failure) {
        if (active && lifecycle.generation === generation && $apiRequestScope.get() === scope) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      } finally {
        if (active && lifecycle.generation === generation && $apiRequestScope.get() === scope) {
          setLoading(false)
        }
      }
    }

    void prepare()

    const unsubscribe = bridge.artifactShare.onChanged(key => {
      if ((key === artifactKey || key === '*') && !lifecycle.busy) {
        setRetry(value => value + 1)
      }
    })

    return () => {
      active = false
      lifecycle.active = false
      lifecycle.generation += 1
      unsubscribe()
    }
  }, [artifactKey, sessionId, path, content, sourceText, literalHtml, scope, bridge, retry, onClose])

  /** 仅把已确认的快照交给原生发布服务；失败留在弹窗内，允许原位重试。 */
  async function publish(ttlDays?: number): Promise<boolean> {
    const generation = owner.current.generation

    if (!prepared || owner.current.busy || !current(generation)) {
      return false
    }

    owner.current.busy = true
    setBusy(true)
    setError('')

    try {
      const next = await bridge.artifactShare.publish({
        key: artifactKey,
        ...(ttlDays === undefined ? {} : { ttlDays }),
        html: prepared.html,
        title,
        source: { sessionId, path, content, ...(path ? { hash: prepared.sourceHash } : {}) }
      })

      if (!current(generation)) {
        return false
      }

      setRecord(next)
      notify({ kind: 'success', title: copy.publishSucceeded, message: title })

      return true
    } catch (failure) {
      if (current(generation)) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }

      return false
    } finally {
      if (current(generation)) {
        owner.current.busy = false
        setBusy(false)
      }
    }
  }

  /** 复制、打开前复核本机权威链接；已撤销链接不继续流出。 */
  async function linkAction(action: 'copy' | 'open'): Promise<boolean> {
    const generation = owner.current.generation

    if (owner.current.busy || !current(generation)) {
      return false
    }

    owner.current.busy = true
    setBusy(true)
    setError('')

    try {
      const found = await bridge.artifactShare.inspect(artifactKey)

      if (!current(generation)) {
        return false
      }

      setRecord(found)

      if (!found || !artifactShareActive(found)) {
        return false
      }

      if (action === 'copy') {
        await writeClipboardText(found.url)
      } else {
        await bridge.openExternal(found.url)
      }

      return true
    } catch (failure) {
      if (current(generation)) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }

      return false
    } finally {
      if (current(generation)) {
        owner.current.busy = false
        setBusy(false)
      }
    }
  }

  /** 撤销由弹窗二次确认后调用，服务端成功前始终保留可用链接。 */
  async function revoke(): Promise<boolean> {
    const generation = owner.current.generation

    if (!record || owner.current.busy || !current(generation)) {
      return false
    }

    owner.current.busy = true
    setBusy(true)
    setError('')

    try {
      await bridge.artifactShare.revoke(artifactKey, record.shareId)

      if (!current(generation)) {
        return false
      }

      setRecord(null)

      return true
    } catch (failure) {
      if (current(generation)) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }

      return false
    } finally {
      if (current(generation)) {
        owner.current.busy = false
        setBusy(false)
      }
    }
  }

  return (
    <ArtifactShareDialogView
      busy={busy}
      changed={!!record && artifactShareActive(record) && !!prepared &&
        (path && record.sourceHash ? record.sourceHash !== prepared.sourceHash : record.hash !== prepared.hash)}
      error={error}
      loading={loading}
      onClose={onClose}
      onLinkAction={linkAction}
      onPublish={publish}
      onRetry={() => setRetry(value => value + 1)}
      onRevoke={revoke}
      publishable={!!prepared}
      record={record}
      title={title}
    />
  )
}
