import type { ConversationShareRecord } from '@hermes/shared/conversation-share'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { CopyButton } from '@/components/ui/copy-button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { Check, ExternalLink, Link2, Trash2 } from '@/lib/icons'

interface ConversationShareViewProps {
  scope: 'session' | 'response'
  title: string
  html: string
  prepared: boolean
  process: boolean
  busy: boolean
  error: string
  record: ConversationShareRecord | null
  records: ConversationShareRecord[]
  onClose: () => void
  onProcessChange: (value: boolean) => void
  onPublish: () => Promise<void>
  onRevoke: (key: string) => Promise<void>
  onRetry: () => void
}

/** 会话和单条回复共享预览、链接结果及撤销确认，历史记录作为次级操作。 */
export function ConversationShareView({
  scope,
  title,
  html,
  prepared,
  process,
  busy,
  error,
  record,
  records,
  onClose,
  onProcessChange,
  onPublish,
  onRevoke,
  onRetry
}: ConversationShareViewProps) {
  const { t, locale } = useI18n()
  const copy = t.conversationShare
  const [revoking, setRevoking] = useState<ConversationShareRecord | null>(null)
  const [linkError, setLinkError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const history = records.filter(item => item.key !== record?.key)

  useEffect(() => {
    if (revoking && !records.some(item => item.key === revoking.key && item.state !== 'revoked')) {
      setRevoking(null)
    }
  }, [records, revoking])

  async function open(url: string): Promise<void> {
    setLinkError('')

    try {
      await openExternalLink(url)
    } catch (failure) {
      setLinkError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  function linkActions(item: ConversationShareRecord) {
    return (
      <div className="flex flex-wrap gap-2">
        <CopyButton
          buttonVariant="outline"
          disabled={busy}
          label={copy.copyLink}
          onCopyError={failure => setLinkError(failure instanceof Error ? failure.message : String(failure))}
          text={item.url!}
        />
        <Button disabled={busy} onClick={() => void open(item.url!)} variant="outline">
          <ExternalLink aria-hidden="true" />
          {copy.openLink}
        </Button>
      </div>
    )
  }

  return (
    <Dialog
      onOpenChange={value => {
        if (!value && !busy) {
          onClose()
        }
      }}
      open
    >
      <DialogContent
        bodyClassName="flex flex-col gap-4 overflow-y-auto"
        className={record || revoking ? 'max-h-[90vh] max-w-lg' : 'max-h-[90vh] max-w-2xl'}
        onEscapeKeyDown={event => {
          if (busy) {
            event.preventDefault()
          }
        }}
        onInteractOutside={event => {
          if (busy) {
            event.preventDefault()
          }
        }}
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 aria-hidden="true" className="size-4" />
            {scope === 'session' ? copy.sessionShare : copy.responseShare}
          </DialogTitle>
          <DialogDescription className="truncate">{title || copy.readonly}</DialogDescription>
        </DialogHeader>
        {revoking ? (
          <>
            <p className="text-sm font-medium">{copy.revoke}</p>
            <p className="text-sm text-muted-foreground">{t.artifactShare.confirmRevoke}</p>
            <p className="truncate text-sm text-muted-foreground">{revoking.title}</p>
            <DialogFooter>
              <Button disabled={busy} onClick={() => setRevoking(null)} variant="ghost">
                {t.common.cancel}
              </Button>
              <Button disabled={busy} loading={busy} onClick={() => void onRevoke(revoking.key)} variant="destructive">
                {copy.revoke}
              </Button>
            </DialogFooter>
          </>
        ) : record ? (
          <>
            <p className="flex items-center gap-2 text-sm">
              <Check aria-hidden="true" className="size-4 text-primary" />
              {t.artifactShare.linkReady}
            </p>
            <p className="text-sm text-muted-foreground">{copy.disclosure}</p>
            <Input
              aria-label={copy.copyLink}
              onFocus={event => event.currentTarget.select()}
              readOnly
              value={record.url}
            />
            {linkActions(record)}
            <DialogFooter>
              <Button disabled={busy} onClick={() => setRevoking(record)} variant="ghost">
                <Trash2 aria-hidden="true" />
                {copy.revoke}
              </Button>
              <Button disabled={busy} onClick={onClose}>
                {t.common.done}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{copy.disclosure}</p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={process} disabled={busy} onCheckedChange={value => onProcessChange(value === true)} />
              {copy.includeProcess}
            </label>
            {html ? (
              <iframe
                className="h-64 w-full shrink-0 bg-background"
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
            <DialogFooter>
              <Button disabled={busy} onClick={onClose} variant="ghost">
                {t.common.cancel}
              </Button>
              <Button disabled={!html || !prepared || busy} loading={busy} onClick={() => void onPublish()}>
                <Link2 aria-hidden="true" />
                {t.artifactShare.createLink}
              </Button>
            </DialogFooter>
          </>
        )}
        {(error || linkError) && (
          <div className="flex items-center justify-between gap-2 text-sm text-destructive" role="alert">
            <span className="min-w-0 break-words">{error || linkError}</span>
            <Button
              disabled={busy}
              onClick={() => {
                setLinkError('')
                onRetry()
              }}
              variant="ghost"
            >
              {copy.retry}
            </Button>
          </div>
        )}
        {!revoking && history.length > 0 && (
          <details className="text-sm" onToggle={event => setHistoryOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer text-muted-foreground">{copy.history}</summary>
            <div className="flex max-h-48 flex-col gap-4 overflow-y-auto pt-4">
              {historyOpen &&
                history.map(item => (
                  <div className="flex flex-col gap-2" key={item.key}>
                    <p className="truncate font-medium">{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.scope === 'session' ? copy.sessionShare : copy.responseShare} ·{' '}
                      {new Date(item.createdAt).toLocaleString(locale)} · {copy[item.state]}
                    </p>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {item.state === 'published' && item.url && linkActions(item)}
                      {item.state !== 'revoked' && (
                        <Button disabled={busy} onClick={() => setRevoking(item)} variant="ghost">
                          <Trash2 aria-hidden="true" />
                          {copy.revoke}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </details>
        )}
      </DialogContent>
    </Dialog>
  )
}
