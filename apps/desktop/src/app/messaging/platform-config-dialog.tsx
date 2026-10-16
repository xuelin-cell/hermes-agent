import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ErrorBanner } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import type { MessagingPlatformInfo } from '@/hermes'
import { useI18n } from '@/i18n'

import { credentialPreview } from '../settings/helpers'

import { CREDENTIAL_KEYS, type PlatformId } from './platform-card'

/** 配置弹窗只编辑原生平台的必要凭据；权限、其它变量和个人设置不随表单写回。 */
export function PlatformConfigDialog({
  platform,
  onClose,
  onSave
}: {
  platform: MessagingPlatformInfo
  onClose: () => void
  onSave: (env: Record<string, string>) => Promise<void>
}) {
  const { t } = useI18n()
  const m = t.messaging
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const id = platform.id as Exclude<PlatformId, 'weixin'>
  const fields = CREDENTIAL_KEYS[id].map(key => platform.env_vars.find(field => field.key === key))
  const complete = fields.every(field => field && (field.is_set || edits[field.key]?.trim()))
  const hasEdits = Object.values(edits).some(value => value.trim())
  const canSave = complete && (hasEdits || !platform.enabled)

  /** 沿用现有保存接口；空输入保留旧凭据，不把脱敏占位值提交给后端。 */
  async function save(event: React.FormEvent) {
    event.preventDefault()

    if (!canSave || saving) {
      return
    }

    setSaving(true)
    setError('')

    try {
      const env = Object.fromEntries(
        Object.entries(edits)
          .map(([key, value]) => [key, value.trim()])
          .filter(([, value]) => value)
      )

      await onSave(env)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.failedSave(platform.name))
      setSaving(false)
    }
  }

  return (
    <Dialog
      onOpenChange={open => {
        if (!open && !saving) {
          onClose()
        }
      }}
      open
    >
      <DialogContent showCloseButton={!saving}>
        <form className="grid gap-4" onSubmit={save}>
          <DialogHeader>
            <DialogTitle>
              {m.cards.configure} · {m.cards.titles[id]}
            </DialogTitle>
            <DialogDescription>{m.cards.descriptions[id]}</DialogDescription>
          </DialogHeader>
          {fields.map((field, index) => {
            if (!field) {
              return <ErrorBanner key={index}>{m.cards.unavailable}</ErrorBanner>
            }

            const copy = m.fieldCopy[field.key]
            const inputId = 'messaging-credential-' + field.key

            return (
              <div className="grid gap-1.5" key={field.key}>
                <label className="text-sm font-medium" htmlFor={inputId}>
                  {copy?.label || field.prompt}
                </label>
                <Input
                  autoComplete="off"
                  disabled={saving}
                  id={inputId}
                  onChange={event => setEdits(current => ({ ...current, [field.key]: event.target.value }))}
                  placeholder={
                    field.is_set
                      ? credentialPreview(field.redacted_value) || m.replaceValue
                      : copy?.placeholder || field.prompt
                  }
                  type={field.is_password ? 'password' : 'text'}
                  value={edits[field.key] || ''}
                />
              </div>
            )
          })}
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <DialogFooter>
            <Button disabled={saving} onClick={onClose} type="button" variant="outline">
              {t.common.cancel}
            </Button>
            <Button disabled={!canSave || saving} type="submit">
              {saving ? m.saving : m.cards.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
