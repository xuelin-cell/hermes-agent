import type { ConversationShareRecord, PreparedConversationShare } from '@hermes/shared/conversation-share'
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { useI18n } from '@/i18n'
import {
  $conversationShareTarget,
  closeConversationShare,
  type ConversationShareTarget
} from '@/store/conversation-share'

import { waitForPreparation } from './preparation-wait'
import { ConversationShareView } from './share-view'

/** 所有会话和回复入口共用单个窗口，关闭时清除预览并取消发布票据。 */
export function ConversationShareDialog() {
  const target = useStore($conversationShareTarget)

  return target ? <ShareWindow key={JSON.stringify(target)} target={target} /> : null
}

interface ShareWindowProps {
  target: ConversationShareTarget
}

/** 先显示公开范围和完整静态预览，再由用户发起发布；迟到结果不能更新新窗口。 */
function ShareWindow({ target }: ShareWindowProps) {
  const { t, locale } = useI18n()
  const copy = t.conversationShare
  const [process, setProcess] = useState(false)
  const [retry, setRetry] = useState(0)
  const [prepared, setPrepared] = useState<PreparedConversationShare | null>(null)
  const [html, setHtml] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [records, setRecords] = useState<ConversationShareRecord[]>([])
  const api = window.hermesDesktop?.conversationShare

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])
    let ticket: string | undefined
    setPrepared(null)
    setHtml('')
    setError('')

    if (!api) {
      setError(copy.unavailable)

      return
    }
    void (async () => {
      try {
        const pending = api
          .prepare(target.owner, {
            ...target.request,
            includeProcess: process,
            locale,
            theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
          })
          .then(async next => {
            ticket = next.ticket

            // IPC 不支持 AbortSignal；超时或关闭后才返回的票据也必须释放。
            if (signal.aborted) {
              await api.cancel(ticket)
              signal.throwIfAborted()
            }

            return next
          })

        const next = await waitForPreparation(pending, signal)

        if (disposed) {
          await api.cancel(next.ticket)

          return
        }

        signal.throwIfAborted()
        const { exportConversationHtml } = await waitForPreparation(import('./snapshot-renderer'), signal)
        signal.throwIfAborted()

        const page = await exportConversationHtml(next.document, copy, signal, reference =>
          api.image(next.ticket, reference)
        )

        if (!disposed) {
          setPrepared(next)
          setHtml(page)
        }
      } catch (failure) {
        if (!disposed) {
          const reason = String(failure instanceof Error ? failure.message : failure)
          setError(signal.aborted ? `${copy.resourceError} ${reason}` : reason)
        }
      }
    })()

    return () => {
      disposed = true
      controller.abort()

      if (ticket) {
        void api.cancel(ticket).catch(() => undefined)
      }
    }
  }, [api, target, process, locale, copy, retry])

  useEffect(() => {
    let disposed = false
    void api
      ?.list(target.owner, target.request.sessionId)
      .then(items => {
        if (!disposed) {
          setRecords(items)
        }
      })
      .catch(failure => {
        if (!disposed) {
          setError(String(failure))
        }
      })

    return () => {
      disposed = true
    }
  }, [api, target, retry])

  /** 保留失败状态供重试；成功后从主进程重新加载本会话的完整本机记录。 */
  async function publish(): Promise<void> {
    if (!api || !prepared || !html || busy) {
      return
    }

    setBusy(true)
    setError('')

    try {
      const published = await api.publish(prepared.ticket, html)

      if ($conversationShareTarget.get() !== target) {
        return
      }

      setRecords(items => [published, ...items.filter(item => item.key !== published.key)])
      const next = await api.list(target.owner, target.request.sessionId)

      if ($conversationShareTarget.get() === target) {
        setRecords(next)
      }
    } catch (failure) {
      if ($conversationShareTarget.get() === target) {
        setError(String(failure instanceof Error ? failure.message : failure))
      }
    } finally {
      if ($conversationShareTarget.get() === target) {
        setBusy(false)
      }
    }
  }

  /** 服务器确认删除后刷新记录，失败时继续保留链接并显示可重试错误。 */
  async function revoke(key: string): Promise<void> {
    if (!api || busy) {
      return
    }

    setBusy(true)
    setError('')

    try {
      await api.revoke(key)
      const next = await api.list(target.owner, target.request.sessionId)

      if ($conversationShareTarget.get() === target) {
        setRecords(next)
      }
    } catch (failure) {
      if ($conversationShareTarget.get() === target) {
        setError(String(failure instanceof Error ? failure.message : failure))
      }
    } finally {
      if ($conversationShareTarget.get() === target) {
        setBusy(false)
      }
    }
  }

  const record =
    records.find(
      item =>
        item.state === 'published' &&
        item.scope === target.request.scope &&
        item.snapshotId === prepared?.document.snapshotId &&
        item.url
    ) ?? null

  return (
    <ConversationShareView
      busy={busy}
      error={error}
      html={html}
      onClose={closeConversationShare}
      onProcessChange={setProcess}
      onPublish={publish}
      onRetry={() => setRetry(value => value + 1)}
      onRevoke={revoke}
      prepared={!!prepared}
      process={process}
      record={record}
      records={records}
      scope={target.request.scope}
      title={prepared?.document.title || ''}
    />
  )
}
