import { mediaKind } from '@/lib/media'
import type { PreviewTarget } from '@/store/preview'

export type PreviewFormat = 'audio' | 'delimited' | 'video'

const FORMAT_BY_EXT = new Map<string, PreviewFormat>([['csv', 'delimited'], ['tsv', 'delimited']])
const MEDIA_FORMATS = { audio: 'audio', file: null, image: null, video: 'video' } as const

/** 只接管已登记的文件类型，其余保留原版预览。 */
export function previewFormat(target: PreviewTarget): PreviewFormat | null {
  if (target.kind !== 'file') {return null}
  const path = target.path || target.source || target.url
  const extension = path.split(/[?#]/, 1)[0].split('.').at(-1)?.toLowerCase() || ''

  return FORMAT_BY_EXT.get(extension) || MEDIA_FORMATS[mediaKind(path)]
}
