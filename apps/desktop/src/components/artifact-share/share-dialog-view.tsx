import type { ArtifactShareRecord } from '@hermes/shared/artifact-share'
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

import {
  ArtifactExpiryDialog,
  ExpiryControls,
  ShareExpiryStatus,
  useArtifactShareExpired,
  validShareDays
} from './expiry'

interface ArtifactShareDialogViewProps {
  title: string
  record: ArtifactShareRecord | null
  loading: boolean
  busy: boolean
  error: string
  publishable: boolean
  changed: boolean
  onClose: () => void
  onPublish: (ttlDays?: number) => Promise<boolean>
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
  const [days, setDays] = useState(1)
  const [editingExpiry, setEditingExpiry] = useState(false)
  const [expiryBusy, setExpiryBusy] = useState(false)
  const expired = useArtifactShareExpired(record)
  const active = !!record && !record.deletedAt && !expired

  useEffect(() => {
    setCopied(false)
    setDismissed(false)

    if (!record?.url || !active) {
      setPending(null)
    }
  }, [record?.url, record?.hash, active])

  useEffect(() => {
    if (!loading && active && changed && !dismissed) {
      setPending('update')
    }
  }, [loading, active, changed, dismissed])

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
    <>
      <Dialog
        onOpenChange={open => {
          if (!open && !busy && !expiryBusy) {
            onClose()
          }
        }}
        open
      >
        <DialogContent
          bodyClassName="flex flex-col gap-4"
          className="max-w-lg"
          onEscapeKeyDown={event => {
            if (busy || expiryBusy) {
              event.preventDefault()
            }
          }}
          onInteractOutside={event => {
            if (busy || expiryBusy) {
              event.preventDefault()
            }
          }}
          showCloseButton={!busy && !expiryBusy}
        >
          {editingExpiry && record ? (
            <ArtifactExpiryDialog
              embedded
              onBusyChange={setExpiryBusy}
              onClose={() => setEditingExpiry(false)}
              onSaved={() => onRetry()}
              record={record}
            />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Link2 aria-hidden="true" className="size-4" />
                  {copy.shareArtifact}
                </DialogTitle>
                <DialogDescription className="break-all">{title}</DialogDescription>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">{copy.disclosure}</p>
              {record && !loading && <ShareExpiryStatus expired={expired} record={record} />}
              {!loading && !pending && record && !record.deletedAt && (
                <Button disabled={busy} onClick={() => setEditingExpiry(true)} size="sm" variant="text">
                  {copy.editValidity}
                </Button>
              )}
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
              ) : record && active ? (
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
                  <ExpiryControls days={days} disabled={busy} onChange={setDays} />
                  <p className="text-xs text-muted-foreground">{copy.expiryNotice}</p>
                  {!publishable && !error && <p className="text-sm text-muted-foreground">{copy.originRequired}</p>}
                  <DialogFooter>
                    <Button disabled={busy} onClick={onClose} variant="ghost">
                      {t.common.cancel}
                    </Button>
                    <Button
                      disabled={busy || !publishable || !validShareDays(days)}
                      loading={busy}
                      onClick={() => void onPublish(days)}
                    >
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
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
