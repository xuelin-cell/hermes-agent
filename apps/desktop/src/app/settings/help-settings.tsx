import { strToU8, zipSync } from 'fflate'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { getLogs } from '@/hermes'
import { useI18n } from '@/i18n'
import { DESKTOP_DOCS_URL } from '@/lib/docs'
import { openExternalLink } from '@/lib/external-link'
import { notify, notifyError } from '@/store/notifications'

import { ListRow, SettingsContent } from './primitives'
import { useSettingsRedesignCopy } from './redesign-copy'

export function redactFeedbackLogs(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
}

export function HelpSettings() {
  const copy = useSettingsRedesignCopy()
  const { locale } = useI18n()
  const zh = locale !== 'en'
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [date, setDate] = useState(() => new Date().toLocaleDateString('en-CA'))
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)

  const addFiles = (incoming: File[]) => {
    const images = incoming.filter(file => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type))

    if ([...files, ...images].reduce((sum, file) => sum + file.size, 0) > 15 * 1024 * 1024) {
      notifyError(
        new Error('Screenshot size limit'),
        zh ? '截图总大小不能超过 15MB' : 'Screenshots must total less than 15MB'
      )

      return
    }

    setFiles(current => [...current, ...images].slice(0, 8))
  }

  async function submit(upload: boolean) {
    setBusy(true)

    try {
      const logs = await getLogs({ lines: 3000 })

      const entries: Record<string, Uint8Array> = {
        'report.txt': strToU8(`Date: ${date}\n\n${description}`),
        'logs.txt': strToU8(redactFeedbackLogs(logs.lines.join('\n')))
      }

      for (const [index, file] of files.entries())
        {entries[
          `screenshots/${index + 1}.${file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png'}`
        ] = new Uint8Array(await file.arrayBuffer())}

      const bytes = zipSync(entries)

      if (upload) {
        if (!window.hermesDesktop?.uploadSettingsFeedback) {throw new Error('Feedback upload is unavailable')}
        await window.hermesDesktop.uploadSettingsFeedback({ bytes, description, date })
      } else {
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }))
        const link = document.createElement('a')
        link.href = url
        link.download = `feedback-${date}.zip`
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }

      notify({
        kind: 'success',
        message: zh ? (upload ? '反馈已上传' : '日志包已保存') : upload ? 'Feedback uploaded' : 'Logs saved'
      })
      setOpen(false)
    } catch (error) {
      notifyError(error, zh ? '无法提交反馈，请重试或保存到本地' : 'Could not submit feedback; retry or save locally')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsContent>
      <div className="settings-card">
        <ListRow
          action={
            <Button onClick={() => setOpen(true)} size="sm">
              {copy('feedback')}
            </Button>
          }
          description={copy('logsDesc')}
          title={copy('feedback')}
        />
        <ListRow
          action={
            <Button onClick={() => void openExternalLink(DESKTOP_DOCS_URL)} size="sm">
              {copy('docs')}
            </Button>
          }
          title={copy('docs')}
        />
      </div>
      <Dialog
        onOpenChange={value => {
          if (!busy) {setOpen(value)}
        }}
        open={open}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy('feedback')}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {zh
              ? '主动上传日志、问题描述和所选截图。日志中的常见凭据会被隐藏；请检查截图后再发送。上传失败时可保存到本地。'
              : 'Upload logs, your description and selected screenshots. Common credentials are redacted from logs; review screenshots before sending. Save locally if upload fails.'}
          </p>
          <label>
            {zh ? '问题发生日期' : 'Problem date'}
            <Input onChange={event => setDate(event.target.value)} type="date" value={date} />
          </label>
          <label>
            {zh ? '问题描述（可选）' : 'Description (optional)'}
            <Textarea
              onChange={event => setDescription(event.target.value)}
              onPaste={event => {
                const images = Array.from(event.clipboardData.files)

                if (images.length) {
                  event.preventDefault()
                  addFiles(images)
                }
              }}
              value={description}
            />
          </label>
          <Input
            accept="image/png,image/jpeg,image/webp"
            aria-label={zh ? '添加截图' : 'Add screenshots'}
            multiple
            onChange={event => addFiles(Array.from(event.target.files ?? []))}
            type="file"
          />
          {files.map((file, index) => (
            <div className="flex items-center justify-between text-xs" key={`${index}:${file.name}`}>
              <span>{file.name}</span>
              <Button
                disabled={busy}
                onClick={() => setFiles(current => current.filter((_, position) => position !== index))}
                size="sm"
              >
                {zh ? '移除' : 'Remove'}
              </Button>
            </div>
          ))}
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={() => void submit(false)}>
              {copy('logs')}
            </Button>
            <Button disabled={busy || !window.hermesDesktop?.uploadSettingsFeedback} onClick={() => void submit(true)}>
              {zh ? '上传到云端' : 'Upload feedback'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsContent>
  )
}
