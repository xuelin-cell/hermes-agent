import { hermesDirectiveFormatter } from '@/components/assistant-ui/directive-text'
import { splitLeadingAttachmentRefs } from '@/components/assistant-ui/reference-kinds'
import { DATA_IMAGE_URL_RE, extractImageRefs, imageBlobExtension } from '@/lib/embedded-images'

/** 将消息正文中的上传附件与已登记附件合并，聊天、历史和编辑使用相同结果。 */
export function splitSentAttachments(text: string, refs: string[] = []): { text: string; refs: string[] } {
  const images = extractImageRefs(text)
  const files = splitLeadingAttachmentRefs(images.cleanedText)
  const lifted = [...files.refs, ...images.refs]

  return {
    text: files.text,
    refs: lifted.length ? [...new Set([...refs, ...lifted])] : refs
  }
}

/** 判断引用是否属于消息附件卡片，包括文件夹和旧消息的内嵌图片。 */
export function isMessageAttachmentRef(ref: string): boolean {
  return /^@(?:file|folder):/.test(ref) || isSentImageRef(ref)
}

/** 识别可预览和重发的已发送图片。 */
export function isSentImageRef(ref: string): boolean {
  return /^@image:/.test(ref) || DATA_IMAGE_URL_RE.test(ref) || /^!\[[^\]\n]*\]\(blob:/.test(ref)
}

/** 统一解析消息中的附件引用，使显示、复制和重发使用同一个来源。 */
export function parseSentAttachment(ref: string) {
  const directImage = ref.startsWith('@image:') ? ref.slice(7) : ref

  if (DATA_IMAGE_URL_RE.test(directImage)) {
    return {
      inline: true,
      kind: 'image',
      label: `image${imageBlobExtension({ type: directImage.slice(5, directImage.indexOf(';')) })}`,
      source: directImage
    } as const
  }

  const [segment, extra] = hermesDirectiveFormatter.parse(ref)
  const mention = !extra && segment?.kind === 'mention' ? segment : undefined

  if (!mention || (mention.type !== 'file' && mention.type !== 'folder' && mention.type !== 'image')) {
    return null
  }

  const { id: source, type: kind } = mention
  const inline = kind === 'image' && (source.startsWith('blob:') || DATA_IMAGE_URL_RE.test(source))
  let label = source.split(/[\\/]/).filter(Boolean).at(-1) || source

  if (DATA_IMAGE_URL_RE.test(source)) {
    label = `image${imageBlobExtension({ type: source.slice(5, source.indexOf(';')) })}`
  } else if (source.startsWith('blob:')) {
    try {
      label = decodeURIComponent(mention.label)
    } catch {
      label = mention.label
    }
  }

  return { inline, kind, label, source } as const
}
