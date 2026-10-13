import { mediaKind } from '@/lib/media'
import type { PreviewTarget } from '@/store/preview'

export type PreviewFormat = 'audio' | 'video'

const MEDIA_FORMATS = { audio: 'audio', file: null, image: null, video: 'video' } as const

/** 只接管已登记的文件类型，其余保留原版预览。 */
export function previewFormat(target: PreviewTarget): PreviewFormat | null {
  return target.kind === 'file' ? MEDIA_FORMATS[mediaKind(target.path || target.source || target.url)] : null
}
