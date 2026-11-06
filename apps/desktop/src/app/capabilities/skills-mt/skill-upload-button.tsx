import { useRef, useState } from 'react'

import { uploadSkillPackage } from '@/api/skills'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { type ProfileScope, profileScopeKey } from '@/hermes'
import { useI18n } from '@/i18n'
import { Upload } from '@/lib/icons'
import { queryClient } from '@/lib/query-client'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'
import { confirm } from '@/store/confirm'
import { notify } from '@/store/notifications'

import { skillsQueryKey } from '../skills/skills-data'

interface Props {
  profile?: ProfileScope
  onUploaded: () => void
}

export function SkillUploadButton(props: Props) {
  return <ScopedUpload key={profileScopeKey(props.profile ?? null)} {...props} />
}

function ScopedUpload({ profile, onUploaded }: Props) {
  const { locale } = useI18n()
  const zh = locale.startsWith('zh')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const pending = useRef(false)
  const title = zh ? '上传技能' : 'Upload skill'

  async function upload(file: File) {
    if (pending.current) {return}
    setError('')

    if (!/\.(zip|skill)$/i.test(file.name) || file.size > 200 * 1024 * 1024) {
      setError(zh ? '请选择不超过 200 MB 的 .zip 或 .skill 技能包' : 'Choose a .zip or .skill package up to 200 MB')

      return
    }

    pending.current = true
    setBusy(true)

    try {
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })

      let result = await uploadSkillPackage(file.name, content, profile)

      if (result.requires_confirmation && result.package_hash) {
        const approved = await confirm({
          title: zh ? '技能安全扫描' : 'Skill security scan',
          description: result.report ?? '',
          destructive: true,
          confirmLabel: zh ? '仍然安装' : 'Install anyway'
        })

        if (!approved) {return}
        result = await uploadSkillPackage(file.name, content, profile, result.package_hash)
      }

      if (!result.ok) {throw new Error(zh ? '技能未能安装，请重试' : 'Skill installation failed. Please retry.')}
      await queryClient.invalidateQueries({ queryKey: skillsQueryKey(profile ?? null) })
      invalidateSlashCompletions()
      onUploaded()
      setOpen(false)
      notify({
        kind: 'success',
        title: result.name,
        message: zh ? '技能已安装，新会话中生效' : 'Skill installed. Available in new chats.'
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        onClick={() => {
          setError('')
          setOpen(true)
        }}
        variant="outline"
      >
        <Upload className="size-4" />
        {title}
      </Button>
      <Dialog
        onOpenChange={value => {
          if (!pending.current) {setOpen(value)}
        }}
        open={open}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <input
            accept=".zip,.skill"
            disabled={busy}
            hidden
            onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ''

              if (file) {void upload(file)}
            }}
            ref={input}
            type="file"
          />
          <Button
            className="h-32 w-full border-dashed"
            disabled={busy}
            onClick={() => input.current?.click()}
            onDragOver={event => event.preventDefault()}
            onDrop={event => {
              event.preventDefault()
              const file = event.dataTransfer.files[0]

              if (file) {void upload(file)}
            }}
            variant="outline"
          >
            {busy
              ? zh
                ? '正在上传并安装…'
                : 'Uploading and installing…'
              : zh
                ? '点击选择或拖拽技能包到此处'
                : 'Choose or drop a skill package here'}
          </Button>
          <p className="text-sm text-muted-foreground">
            {zh
              ? '支持 .zip / .skill：压缩包最大 200 MB，最多 20,000 个文件，解压后最大 1 GB。包内须包含带有效名称的 SKILL.md；安装后在新会话中生效。'
              : 'Supports .zip / .skill: up to 200 MB, 20,000 files, and 1 GB extracted. Include SKILL.md with a valid name; installed skills apply in new chats.'}
          </p>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
