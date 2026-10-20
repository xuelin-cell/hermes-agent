import { artifactShareExpired, type ArtifactShareRecord } from '@hermes/shared/artifact-share'
import { useEffect, useRef, useState } from 'react'

import { $apiRequestScope } from '@/api/client'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'

export function validShareDays(days: number): boolean {
  return Number.isInteger(days) && days >= 1 && days <= 7
}

/** Repaint at the actual deadline, even when no new native event arrives. */
export function useArtifactShareExpired(record: ArtifactShareRecord | null): boolean {
  const [, repaint] = useState(0)
  const deadline = record?.expiresAt
  useEffect(() => {
    if (!deadline) {
      return
    }

    const delay = new Date(deadline).getTime() - Date.now()

    if (!Number.isFinite(delay) || delay < 0) {
      return
    }

    const timer = window.setTimeout(() => repaint(value => value + 1), Math.min(delay + 1, 2_147_483_647))

    return () => window.clearTimeout(timer)
  }, [deadline])

  return !!record && artifactShareExpired(record)
}

interface ExpiryControlsProps {
  days: number
  onChange: (days: number) => void
  disabled?: boolean
}

export function ExpiryControls({ days, onChange, disabled }: ExpiryControlsProps) {
  const { t } = useI18n()
  const [choice, setChoice] = useState('1')

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">{t.artifactShare.validity}</span>
        <Select
          disabled={disabled}
          onValueChange={value => {
            setChoice(value)

            if (value !== 'custom') {
              onChange(Number(value))
            }
          }}
          value={choice}
        >
          <SelectTrigger aria-label={t.artifactShare.validity}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 3, 7].map(value => (
              <SelectItem key={value} value={String(value)}>
                {t.artifactShare.days(value)}
              </SelectItem>
            ))}
            <SelectItem value="custom">{t.artifactShare.customValidity}</SelectItem>
          </SelectContent>
        </Select>
        {choice === 'custom' && (
          <Input
            aria-label={t.artifactShare.customValidity}
            className="w-24"
            disabled={disabled}
            max={7}
            min={1}
            onChange={event => onChange(Number(event.currentTarget.value))}
            step={1}
            type="number"
            value={days || ''}
          />
        )}
      </div>
      {!validShareDays(days) && (
        <p className="text-xs text-destructive" role="alert">
          {t.artifactShare.invalidValidity}
        </p>
      )}
    </div>
  )
}

export function ShareExpiryStatus({ record, expired }: { record: ArtifactShareRecord; expired: boolean }) {
  const { t, locale } = useI18n()
  const date = record.expiresAt && new Date(record.expiresAt)

  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        {date && Number.isFinite(date.getTime())
          ? t.artifactShare.expiresAt(
              new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
            )
          : t.artifactShare.noExpiry}
      </p>
      {expired && <p role="status">{record.deletedAt ? t.artifactShare.expired : t.artifactShare.cleanupPending}</p>}
    </div>
  )
}

interface ArtifactExpiryDialogProps {
  record: ArtifactShareRecord
  embedded?: boolean
  onBusyChange?: (busy: boolean) => void
  onClose: () => void
  onSaved: (record: ArtifactShareRecord) => void
}

export function ArtifactExpiryDialog({ record, onClose, onSaved, embedded, onBusyChange }: ArtifactExpiryDialogProps) {
  const { t } = useI18n()
  const [days, setDays] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [scope] = useState(() => $apiRequestScope.get())
  const [api] = useState(() => window.hermesDesktop.artifactShare)
  const lifecycle = useRef({ active: false })
  useEffect(() => {
    const owner = lifecycle.current
    owner.active = true

    return () => {
      owner.active = false
    }
  }, [])
  useEffect(() => {
    onBusyChange?.(busy)

    return () => onBusyChange?.(false)
  }, [busy, onBusyChange])
  useEffect(() => $apiRequestScope.listen(() => onClose()), [onClose])

  async function save(): Promise<void> {
    if (busy || !validShareDays(days) || $apiRequestScope.get() !== scope) {
      return
    }

    setBusy(true)
    setError('')

    try {
      const next = await api.setExpiration(record.key, record.shareId, days)

      if (lifecycle.current.active && $apiRequestScope.get() === scope) {
        onSaved(next)
        onClose()
      }
    } catch (failure) {
      if (lifecycle.current.active && $apiRequestScope.get() === scope) {
        setError(
          (failure instanceof Error ? failure.message : String(failure)).replace(
            /^Error invoking remote method '[^']+': (?:Error: )?/,
            ''
          )
        )
      }
    } finally {
      setBusy(false)
    }
  }

  const content = (
    <>
      <DialogHeader>
        <DialogTitle>{t.artifactShare.editValidity}</DialogTitle>
        <DialogDescription>{record.title || t.artifactShare.shareArtifact}</DialogDescription>
      </DialogHeader>
      <ExpiryControls days={days} disabled={busy} onChange={setDays} />
      <p className="text-xs text-muted-foreground">{t.artifactShare.expiryNotice}</p>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button disabled={busy} onClick={onClose} variant="ghost">
          {t.common.cancel}
        </Button>
        <Button disabled={busy || !validShareDays(days)} loading={busy} onClick={() => void save()}>
          {t.artifactShare.saveValidity}
        </Button>
      </DialogFooter>
    </>
  )

  if (embedded) {
    return content
  }

  return (
    <Dialog onOpenChange={open => !open && !busy && onClose()} open>
      <DialogContent
        className="max-w-md"
        onEscapeKeyDown={event => busy && event.preventDefault()}
        onInteractOutside={event => busy && event.preventDefault()}
        showCloseButton={!busy}
      >
        {content}
      </DialogContent>
    </Dialog>
  )
}
