import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
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
import { Check, Copy, ExternalLink, Link2, RefreshCw, Trash2 } from '@/lib/icons'

import type { ArtifactShareRecord } from './share-dialog'

interface ArtifactShareDialogViewProps {
  title: string
  record: ArtifactShareRecord | null
  loading: boolean
  busy: boolean
  error: string
  publishable: boolean
  changed: boolean
  onClose: () => void
  onPublish: () => Promise<boolean>
  onRevoke: () => Promise<boolean>
  onLinkAction: (action: 'copy' | 'open') => Promise<boolean>
  onRetry: () => void
}

/** 原生 Hermes 对话框承载公开提示、链接和确认操作，不在按钮点击时暗中发布。 */
export function ArtifactShareDialogView({
  title,
  record,
  loading,
  busy,
  error,
  publishable,
  changed,
  onClose,
  onPublish,
  onRevoke,
  onLinkAction,
  onRetry
}: ArtifactShareDialogViewProps) {
  const { t } = useI18n()
  const copy = t.artifactShare
  const [pending, setPending] = useState<'copy' | 'open' | 'update' | 'revoke' | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setCopied(false)
    setDismissed(false)

    if (!record?.url) {
      setPending(null)
    }
  }, [record?.url, record?.hash])

  useEffect(() => {
    if (!loading && changed && !dismissed) {
      setPending('update')
    }
  }, [loading, changed, dismissed])

  /** 更新确认可承接复制或打开意图；取消则仍可访问原先的公开快照。 */
  async function confirm(): Promise<void> {
    if (pending === 'revoke') {
      if (await onRevoke()) {
        setPending(null)
      }
    } else if (await onPublish()) {
      const action = pending
      setPending(null)
      setDismissed(false)

      if (action === 'copy' || action === 'open') {
        await act(action)
      }
    }
  }

  /** 变化内容先询问是否覆盖，用户明确保留旧版本后不重复打断链接操作。 */
  async function act(action: 'copy' | 'open'): Promise<void> {
    if (changed && !dismissed && pending === null) {
      setPending(action)

      return
    }

    const success = await onLinkAction(action)

    if (action === 'copy' && success) {
      setCopied(true)
    }
  }

  return (
    <Dialog
      onOpenChange={open => {
        if (!open && !busy) {
          onClose()
        }
      }}
      open
    >
      <DialogContent
        bodyClassName="flex flex-col gap-4"
        className="max-w-lg"
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
            {copy.shareArtifact}
          </DialogTitle>
          <DialogDescription className="break-all">{title}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{copy.disclosure}</p>
        {loading ? (
          <p className="text-sm text-muted-foreground" role="status">
            {copy.checking}
          </p>
        ) : pending ? (
          <>
            <p className="text-sm font-medium">{pending === 'revoke' ? copy.revokeShared : copy.updateShared}</p>
            <p className="text-sm text-muted-foreground">
              {pending === 'revoke' ? copy.confirmRevoke : copy.confirmUpdate}
            </p>
            <DialogFooter>
              <Button
                disabled={busy}
                onClick={() => {
                  setDismissed(true)
                  setPending(null)
                }}
                variant="ghost"
              >
                {t.common.cancel}
              </Button>
              <Button
                disabled={busy}
                loading={busy}
                onClick={() => void confirm()}
                variant={pending === 'revoke' ? 'destructive' : 'default'}
              >
                {pending === 'revoke' ? copy.revokeShared : copy.updateShared}
              </Button>
            </DialogFooter>
          </>
        ) : record ? (
          <>
            <p className="flex items-center gap-2 text-sm">
              <Check aria-hidden="true" className="size-4 text-primary" />
              {copy.linkReady}
            </p>
            {changed && <p className="text-sm text-muted-foreground">{copy.changedNotice}</p>}
            <Input
              aria-label={copy.copyShared}
              onFocus={event => event.currentTarget.select()}
              readOnly
              value={record.url}
            />
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void act('copy')} variant="outline">
                <Copy aria-hidden="true" />
                {copied ? t.common.copied : copy.copyShared}
              </Button>
              <Button disabled={busy} onClick={() => void act('open')} variant="outline">
                <ExternalLink aria-hidden="true" />
                {copy.viewShared}
              </Button>
            </div>
            <DialogFooter className="justify-between">
              <Button disabled={busy} onClick={() => setPending('revoke')} variant="ghost">
                <Trash2 aria-hidden="true" />
                {copy.revokeShared}
              </Button>
              <Button disabled={busy || !publishable || !changed} onClick={() => setPending('update')}>
                <RefreshCw aria-hidden="true" />
                {copy.updateShared}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {!publishable && !error && <p className="text-sm text-muted-foreground">{copy.originRequired}</p>}
            <DialogFooter>
              <Button disabled={busy} onClick={onClose} variant="ghost">
                {t.common.cancel}
              </Button>
              <Button disabled={busy || !publishable} loading={busy} onClick={() => void onPublish()}>
                <Link2 aria-hidden="true" />
                {copy.createLink}
              </Button>
            </DialogFooter>
          </>
        )}
        {error && (
          <div className="flex items-center justify-between gap-2 text-sm text-destructive" role="alert">
            <span className="break-words">{error}</span>
            <Button disabled={busy || loading} onClick={onRetry} variant="ghost">
              {t.common.retry}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
