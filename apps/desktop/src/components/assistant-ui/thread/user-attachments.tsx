import { AttachmentList } from '@/app/chat/composer/attachments'
import { isPastedContentPath } from '@/app/chat/composer/large-paste'
import { useI18n } from '@/i18n'
import { parseSentAttachment } from '@/lib/sent-attachments'
import type { ComposerAttachment } from '@/store/composer'

/** 消息与编辑区共用等大的附件卡片，按原顺序显示。 */
export function UserAttachments({ refs }: { refs: readonly string[] }) {
  const { t } = useI18n()
  const attachments: ComposerAttachment[] = []

  for (const [index, ref] of refs.entries()) {
    const item = parseSentAttachment(ref)

    if (!item) {
      continue
    }

    const { inline, kind, label, source } = item
    const isImageUrl = kind === 'image' && (inline || /^https?:\/\//i.test(source))

    attachments.push({
      id: `${kind}:${index}`,
      kind,
      label: isPastedContentPath(source) ? t.desktop.pastedContent : label,
      ...(isImageUrl ? { previewUrl: source } : { detail: source, path: source })
    })
  }

  return <AttachmentList attachments={attachments} tiles />
}
