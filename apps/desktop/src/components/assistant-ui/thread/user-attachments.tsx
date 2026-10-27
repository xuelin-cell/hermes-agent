import { AttachmentList } from '@/app/chat/composer/attachments'
import { isPastedContentPath } from '@/app/chat/composer/large-paste'
import { DirectiveContent, hermesDirectiveFormatter } from '@/components/assistant-ui/directive-text'
import { useI18n } from '@/i18n'
import { pathLabel } from '@/lib/chat-runtime'

/** 已发送文档复用输入框的卡片与预览；图片及其他引用仍按原方式展示。 */
export function UserAttachments({ refs }: { refs: readonly string[] }) {
  const { t } = useI18n()

  return refs.map((ref, index) => {
    const segments = hermesDirectiveFormatter.parse(ref)
    const segment = segments[0]

    if (segments.length !== 1 || segment?.kind !== 'mention' || segment.type !== 'file') {
      return <DirectiveContent key={index} text={ref} />
    }

    const path = segment.id

    return (
      <AttachmentList
        attachments={[
          {
            id: `file:${path}`,
            kind: 'file',
            label: isPastedContentPath(path) ? t.desktop.pastedContent : pathLabel(path),
            detail: path,
            path
          }
        ]}
        key={index}
      />
    )
  })
}
