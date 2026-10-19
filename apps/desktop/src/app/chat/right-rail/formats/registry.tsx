import { type ComponentProps, type ComponentType, lazy, type LazyExoticComponent } from 'react'

import type { LocalFilePreview } from '../preview-file'

import type { PreviewFailure } from './failure'
import type { PreviewFormat } from './kinds'

export interface FormatRendererProps extends ComponentProps<typeof LocalFilePreview> {
  onFailure: (failure: PreviewFailure) => void
  /** 预览中心算好的文件路径；显示器不自行推导，保证读取、出口和原版预览指向同一文件。 */
  path: string
}

type RendererLoader = () => Promise<{ default: ComponentType<FormatRendererProps> }>
// 懒加载和空闲预载共用入口，避免出现两套格式映射或提前静态引入大模块。
const media = () => import('./media-preview')
// 普通 PDF 和 Office 候选使用同一份模块缓存。
const pdf = () => import('./pdf-file-preview')

const LOADERS: Record<PreviewFormat, readonly RendererLoader[]> = {
  audio: [media],
  delimited: [() => import('./delimited-preview')],
  pdf: [pdf],
  sheet: [() => import('./sheet-preview'), pdf],
  slides: [() => import('./slides-preview')],
  tiff: [() => import('./tiff-preview')],
  video: [media],
  word: [pdf, () => import('./docx-preview')]
}

// 显示器只在这张表登记；后续格式按顺序追加真正可用的候选。
export const FORMAT_RENDERERS = {} as Record<
  PreviewFormat,
  readonly LazyExoticComponent<ComponentType<FormatRendererProps>>[]
>

for (const kind of Object.keys(LOADERS) as PreviewFormat[]) {
  FORMAT_RENDERERS[kind] = LOADERS[kind].map(load => lazy(load))
}

/** 空闲时只预载卡片对应格式的代码；失败仍交给正式打开时的原有错误出口。 */
export async function preloadFormat(kind: PreviewFormat, path: string): Promise<void> {
  const loaders = kind === 'word' && !/\.docx$/i.test(path) ? LOADERS[kind].slice(0, 1) : LOADERS[kind]
  await Promise.all(loaders.map(load => load()))
}

/** 前端 Word 候选仅支持 docx；其它 Word 格式保留原转换失败原因与出口。 */
export function formatRenderers(kind: PreviewFormat, path: string) {
  const renderers = FORMAT_RENDERERS[kind]

  return kind === 'word' && !/\.docx$/i.test(path) ? renderers.slice(0, 1) : renderers
}
