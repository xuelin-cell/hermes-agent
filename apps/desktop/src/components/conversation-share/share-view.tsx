import type { ConversationShareRecord } from '@hermes/shared/conversation-share'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
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
import { registerPluginLocales, usePluginI18n } from '@/i18n/plugin-i18n'
import { openExternalLink } from '@/lib/external-link'
import { Check, ExternalLink, Link2, Trash2 } from '@/lib/icons'

const SCOPE = 'desktop-mt.conversation-share-view'
registerPluginLocales(SCOPE, {
  en: {
    missingImages: (count: number, list: string) =>
      `${count} image${count === 1 ? '' : 's'} (no. ${list}) could not be embedded and will appear as placeholders after publishing.`
  },
  zh: {
    missingImages: (count: number, list: string) =>
      `有 ${count} 张图片无法嵌入分享页（第 ${list} 张），发布后将显示为占位。`
  },
  'zh-hant': {
    missingImages: (count: number, list: string) =>
      `有 ${count} 張圖片無法嵌入分享頁（第 ${list} 張），發佈後將顯示為佔位。`
  }
})

interface ConversationShareViewProps {
  scope: 'session' | 'response'
  title: string
  html: string
  /** 未能嵌入的正文图片序号；发布前提示分享者，不阻止发布。 */
  missingImages: number[]
  prepared: boolean
  busy: boolean
  error: string
  record: ConversationShareRecord | null
  records: ConversationShareRecord[]
  onClose: () => void
  onPublish: () => Promise<void>
  onRevoke: (key: string) => Promise<void>
  onRetry: () => void
}

/** 会话和单条回复共享预览、链接结果及撤销确认，历史记录作为次级操作。 */
export function ConversationShareView({
  scope,
  title,
  html,
  missingImages,
  prepared,
  busy,
  error,
  record,
  records,
  onClose,
  onPublish,
  onRevoke,
  onRetry
}: ConversationShareViewProps) {
  const { t, locale } = useI18n()
  const copy = t.conversationShare
  const viewCopy = usePluginI18n(SCOPE)
  const [revoking, setRevoking] = useState<ConversationShareRecord | null>(null)
  const [linkError, setLinkError] = useState('')

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
            {html && missingImages.length > 0 && (
              <p className="text-sm text-amber-600 dark:text-amber-400" role="status">
                {viewCopy(
                  'missingImages',
                  missingImages.length,
                  missingImages.join(locale.startsWith('zh') ? '、' : ', ')
                )}
              </p>
            )}
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
      </DialogContent>
    </Dialog>
  )
}
