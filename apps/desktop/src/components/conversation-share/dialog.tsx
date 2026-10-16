import type { ConversationShareRecord, PreparedConversationShare } from '@hermes/shared/conversation-share'
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { CopyButton } from '@/components/ui/copy-button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { ExternalLink, Trash2 } from '@/lib/icons'
import {
  $conversationShareTarget,
  closeConversationShare,
  type ConversationShareTarget
} from '@/store/conversation-share'

import { waitForPreparation } from './preparation-wait'

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
      await api.publish(prepared.ticket, html)
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

  return (
    <Dialog
      onOpenChange={open => {
        if (!open) {
          closeConversationShare()
        }
      }}
      open
    >
      <DialogContent bodyClassName="flex flex-col gap-3 overflow-y-auto" className="max-h-[90vh] max-w-4xl">
        <DialogHeader>
          <DialogTitle>{target.request.scope === 'session' ? copy.sessionShare : copy.responseShare}</DialogTitle>
          <DialogDescription>{copy.disclosure}</DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={process} disabled={busy} onCheckedChange={value => setProcess(value === true)} />
          {copy.includeProcess}
        </label>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {html ? (
          <iframe
            className="h-[40vh] min-h-64 shrink-0 w-full bg-background"
            referrerPolicy="no-referrer"
            sandbox=""
            srcDoc={html}
            title={copy.preview}
          />
        ) : !error ? (
          <p className="py-8 text-sm text-muted-foreground" role="status">
            {copy.preparing}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button disabled={busy} onClick={() => setRetry(value => value + 1)} variant="ghost">
            {copy.retry}
          </Button>
          <Button disabled={!html || !prepared || busy} onClick={() => void publish()}>
            {busy ? copy.working : copy.publish}
          </Button>
        </div>
        <section aria-label={copy.history} className="max-h-44 overflow-auto">
          <h3 className="text-sm font-medium">{copy.history}</h3>
          {!records.length && <p className="py-2 text-sm text-muted-foreground">{copy.empty}</p>}
          {records.map(record => (
            <div className="flex items-center gap-2 py-2 text-sm" key={record.key}>
              <div className="min-w-0 flex-1">
                <p className="truncate">{record.title}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(record.createdAt).toLocaleString(locale)} · {copy[record.state]}
                </p>
              </div>
              {record.state === 'published' && record.url && (
                <>
                  <CopyButton appearance="icon" label={copy.copyLink} text={record.url} />
                  <TooltipIconButton onClick={() => void openExternalLink(record.url!)} tooltip={copy.openLink}>
                    <ExternalLink className="size-3.5" />
                  </TooltipIconButton>
                </>
              )}
              {record.state !== 'revoked' && (
                <TooltipIconButton disabled={busy} onClick={() => void revoke(record.key)} tooltip={copy.revoke}>
                  <Trash2 className="size-3.5" />
                </TooltipIconButton>
              )}
            </div>
          ))}
        </section>
        <Button onClick={closeConversationShare} variant="ghost">
          {t.common.close}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
