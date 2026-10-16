import { isUnderPath, isWindowsAbsolutePath } from '@/lib/path-compare'
import { previewArtifactKey } from '@/lib/preview-targets'

/** 将文件预览和浏览器中的 file URL 统一为工作区内的产物路径，不依赖 outputs 目录名。 */
export function artifactShareFilePath(value: string, cwd: string): string | null {
  if (!cwd) {
    return null
  }

  const path = previewArtifactKey(value, cwd)
  const absolute = path.startsWith('/') || isWindowsAbsolutePath(path)

  if (!absolute || path.split(/[\\/]/).includes('..') || !isUnderPath(cwd, path) || !/\.(html?|md|mdx|markdown)$/i.test(path)) {
    return null
  }

  return path
}
