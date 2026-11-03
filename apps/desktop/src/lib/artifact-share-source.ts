import { isBrowserShell } from '@/lib/browser-shell'
import { isUnderPath, isWindowsAbsolutePath } from '@/lib/path-compare'
import { previewArtifactKey } from '@/lib/preview-targets'

/** 云端由实例核验产物来源；本机仍限定工作区。这里只解析路径，不授予分享资格。 */
export function artifactShareFilePath(value: string, cwd: string): string | null {
  const instance = isBrowserShell()

  if (!cwd && !instance) {
    return null
  }

  const path = previewArtifactKey(value, cwd)
  const absolute = path.startsWith('/') || isWindowsAbsolutePath(path)

  if (
    !absolute ||
    path.split(/[\\/]/).includes('..') ||
    (!instance && !isUnderPath(cwd, path)) ||
    !/\.(html?|md|mdx|markdown)$/i.test(path)
  ) {
    return null
  }

  return path
}
