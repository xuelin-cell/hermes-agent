import { type ComponentProps, type ComponentType, lazy, type LazyExoticComponent } from 'react'

import type { LocalFilePreview } from '../preview-file'

import type { PreviewFailure } from './failure'
import type { PreviewFormat } from './kinds'

export interface FormatRendererProps extends ComponentProps<typeof LocalFilePreview> {
  onFailure: (failure: PreviewFailure) => void
}

const MediaPreview = lazy(() => import('./media-preview'))
const DelimitedPreview = lazy(() => import('./delimited-preview'))
const TiffPreview = lazy(() => import('./tiff-preview'))

// 显示器只在这张表登记；后续格式按顺序追加真正可用的候选。
export const FORMAT_RENDERERS: Record<
  PreviewFormat,
  readonly LazyExoticComponent<ComponentType<FormatRendererProps>>[]
> = {
  audio: [MediaPreview],
  delimited: [DelimitedPreview],
  tiff: [TiffPreview],
  video: [MediaPreview]
}
