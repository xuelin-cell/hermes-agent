import type { Translations } from '@/i18n'

/** 从原生 Markdown 渲染器取得分享快照，未内嵌图片沿用既有拒绝规则。 */
export function markdownShareSnapshot(root: HTMLElement | null, copy: Translations['artifactShare']): string {
  const rendered = root?.querySelector<HTMLElement>('[data-preview-markdown]')

  if (!rendered) {
    throw new Error(copy.previewNotReady)
  }

  const clone = rendered.cloneNode(true) as HTMLElement

  for (const image of clone.querySelectorAll('img')) {
    if (!image.getAttribute('src')?.startsWith('data:')) {
      throw new Error(copy.imageNotEmbedded)
    }
  }

  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font:16px/1.65 system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 24px;color:#202124}' +
    'pre{overflow:auto;padding:16px;background:#f5f5f5}img{max-width:100%}table{border-collapse:collapse}' +
    'td,th{border:1px solid #ccc;padding:6px}</style></head><body>' +
    clone.outerHTML +
    '</body></html>'
  )
}
