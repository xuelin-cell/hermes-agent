import { formatRefValue } from '@/components/assistant-ui/directive-text'
import { escapeHtml } from '@/components/assistant-ui/embeds/escape-html'
import { attachmentId } from '@/lib/chat-runtime'
import { dataUrlToBlob, imageBlobExtension } from '@/lib/embedded-images'
import { localPreviewTarget } from '@/lib/local-preview'
import { isWindowsAbsolutePath } from '@/lib/path-compare'
import { parseSentAttachment } from '@/lib/sent-attachments'
import { type ComposerAttachment, createComposerAttachmentOccurrenceId } from '@/store/composer'

const MARKER = 'data-hermes-message-copy'
let copiedMessage: { token: string; attachments: ComposerAttachment[] } | undefined

/** 将已发附件绑定到源会话的目录，临时图片则写入已有的图片缓存。 */
async function copyableAttachment(ref: string, cwd: string): Promise<ComposerAttachment> {
  const parsed = parseSentAttachment(ref)

  if (!parsed) {
    throw new Error('Cannot resolve the copied attachment')
  }

  const { inline, kind, label, source } = parsed
  let path: string | undefined

  if (inline) {
    const blob = source.startsWith('blob:') ? await (await fetch(source)).blob() : dataUrlToBlob(source)

    if (blob?.size && blob.type.startsWith('image/')) {
      path = await window.hermesDesktop?.saveImageBuffer(
        new Uint8Array(await blob.arrayBuffer()),
        imageBlobExtension(blob)
      )
    }
  } else {
    const target = localPreviewTarget(source, cwd)

    if (target?.kind === 'file') {
      path = target.path
    }
  }

  if (!path || (!path.startsWith('/') && !isWindowsAbsolutePath(path))) {
    throw new Error('Cannot resolve the copied attachment')
  }

  return {
    id: attachmentId(kind, path),
    kind,
    label,
    detail: path,
    path,
    ...(kind !== 'image' ? { refText: `@${kind}:${formatRefValue(path)}` } : {})
  }
}

/** 正文写入系统剪贴板，附件留在当前桌面窗口，只通过随机标记关联。 */
export async function copyMessageWithAttachments(text: string, refs: readonly string[], cwd: string) {
  const token = crypto.randomUUID()
  const attachments = await Promise.all(refs.map(ref => copyableAttachment(ref, cwd)))
  const html = `<span ${MARKER}="${token}">${escapeHtml(text).replace(/\r?\n/g, '<br>') || '&#8203;'}</span>`

  if (window.hermesDesktop?.writeClipboard) {
    await window.hermesDesktop.writeClipboard(text, html)
  } else {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' })
      })
    ])
  }

  copiedMessage = { token, attachments }
}

/** 只恢复本窗口复制的附件，外部剪贴板无法借此传入任意文件路径。 */
export function readCopiedMessageAttachments(clipboard: DataTransfer): ComposerAttachment[] {
  if (!copiedMessage || !clipboard.getData('text/html').includes(`${MARKER}="${copiedMessage.token}"`)) {
    return []
  }

  return copiedMessage.attachments.map(attachment => ({
    ...attachment,
    occurrenceId: createComposerAttachmentOccurrenceId()
  }))
}
