import { OFFICE_EXTENSIONS } from '@hermes/shared'

import { mediaKind } from '@/lib/media'
import type { PreviewTarget } from '@/store/preview'

import { filePathForTarget } from '../preview-file'

export type PreviewFormat = 'audio' | 'delimited' | 'slides' | 'tiff' | 'video' | 'word'

const FORMAT_BY_EXT = new Map<string, PreviewFormat>([
  ...OFFICE_EXTENSIONS.word.map(extension => [extension, 'word'] as const),
  ...OFFICE_EXTENSIONS.slides.map(extension => [extension, 'slides'] as const),
  ['csv', 'delimited'],
  ['tsv', 'delimited'],
  ['tif', 'tiff'],
  ['tiff', 'tiff']
])

const MEDIA_FORMATS = { audio: 'audio', file: null, image: null, video: 'video' } as const

/** 只接管已登记的文件类型，其余保留原版预览。 */
export function previewFormat(target: PreviewTarget): PreviewFormat | null {
  if (target.kind !== 'file') {
    return null
  }

  const path = filePathForTarget(target)
  const extension = path.split(/[?#]/, 1)[0].split('.').at(-1)?.toLowerCase() || ''

  return FORMAT_BY_EXT.get(extension) || MEDIA_FORMATS[mediaKind(path)]
}
