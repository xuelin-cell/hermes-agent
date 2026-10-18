import type { PreviewTarget } from '@/store/preview'

/** 路径推导与显示器分开，格式判断和空闲准备不必先加载整个预览界面。 */
export function filePathForTarget(target: PreviewTarget): string {
  if (target.path) {
    return target.path
  }

  try {
    const url = new URL(target.url)

    return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : target.url
  } catch {
    return target.url
  }
}
