import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'

import { openPptxPages } from './pptx-pages'
import type { FormatRendererProps } from './registry'
import { SlidesViewer, useSlidePages } from './slides-preview'
import { readPreviewBytes } from './source'

/** 直接读取原文件在本机解析。 */
function openLocalPages(path: string, signal: AbortSignal) {
  return readPreviewBytes(path).then(bytes => (signal.aborted ? null : openPptxPages(bytes)))
}

/** 没有可用转换软件（如 Mac 只装了 WPS）时的 pptx 阅读器：本机直接画出幻灯片，查看方式与转换后一致。 */
export default function PptxPreview(props: FormatRendererProps) {
  const { t } = useI18n()
  const source = useSlidePages(openLocalPages, props)

  return source ? <SlidesViewer label={props.target.label} source={source} /> : <PageLoader label={t.preview.loading} />
}
