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
    '<style>body{font:16px/1.75 system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 24px;color:#202124;overflow-wrap:anywhere}' +
    'pre{overflow:auto;white-space:pre;overflow-wrap:normal;padding:16px;background:#f5f5f5}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}' +
    'td,th{border:1px solid #ccc;padding:12px 16px;line-height:1.75}a{color:#2563eb;text-decoration:underline}h1,h2,h3,h4,h5,h6{line-height:1.4}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #ccc}li>p{margin-bottom:8px}[data-preview-table]{overflow-x:auto;max-width:100%}</style></head><body>' +
    clone.outerHTML +
    '</body></html>'
  )
}
