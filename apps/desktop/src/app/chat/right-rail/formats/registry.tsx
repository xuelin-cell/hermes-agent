import { type ComponentProps, type ComponentType, lazy, type LazyExoticComponent } from 'react'

import type { LocalFilePreview } from '../preview-file'

import type { PreviewFailure } from './failure'
import type { PreviewFormat } from './kinds'

export interface FormatRendererProps extends ComponentProps<typeof LocalFilePreview> {
  onFailure: (failure: PreviewFailure) => void
  /** 预览中心算好的文件路径；显示器不自行推导，保证读取、出口和原版预览指向同一文件。 */
  path: string
}

const MediaPreview = lazy(() => import('./media-preview'))
const DelimitedPreview = lazy(() => import('./delimited-preview'))
const TiffPreview = lazy(() => import('./tiff-preview'))
const PdfFilePreview = lazy(() => import('./pdf-file-preview'))
const DocxPreview = lazy(() => import('./docx-preview'))
const SlidesPreview = lazy(() => import('./slides-preview'))
const SheetPreview = lazy(() => import('./sheet-preview'))

// 显示器只在这张表登记；后续格式按顺序追加真正可用的候选。
export const FORMAT_RENDERERS: Record<
  PreviewFormat,
  readonly LazyExoticComponent<ComponentType<FormatRendererProps>>[]
> = {
  audio: [MediaPreview],
  delimited: [DelimitedPreview],
  pdf: [PdfFilePreview],
  sheet: [SheetPreview, PdfFilePreview],
  slides: [SlidesPreview],
  tiff: [TiffPreview],
  video: [MediaPreview],
  word: [PdfFilePreview, DocxPreview]
}

/** 前端 Word 候选仅支持 docx；其它 Word 格式保留原转换失败原因与出口。 */
export function formatRenderers(kind: PreviewFormat, path: string) {
  const renderers = FORMAT_RENDERERS[kind]

  return kind === 'word' && !/\.docx$/i.test(path) ? renderers.slice(0, 1) : renderers
}
