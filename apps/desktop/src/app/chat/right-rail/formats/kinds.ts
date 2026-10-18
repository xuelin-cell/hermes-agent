import { fileExtension, OFFICE_EXTENSIONS } from '@hermes/shared'

import { mediaKind } from '@/lib/media'
import type { PreviewTarget } from '@/store/preview'

import { filePathForTarget } from './path'

export type PreviewFormat = 'audio' | 'delimited' | 'pdf' | 'sheet' | 'slides' | 'tiff' | 'video' | 'word'

const FORMAT_BY_EXT = new Map<string, PreviewFormat>([
  ...OFFICE_EXTENSIONS.word.map(extension => [extension, 'word'] as const),
  ...OFFICE_EXTENSIONS.slides.map(extension => [extension, 'slides'] as const),
  ...OFFICE_EXTENSIONS.sheet.map(extension => [extension, 'sheet'] as const),
  ['csv', 'delimited'],
  ['tsv', 'delimited'],
  ['pdf', 'pdf'],
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

  return FORMAT_BY_EXT.get(fileExtension(path)) || MEDIA_FORMATS[mediaKind(path)]
}
