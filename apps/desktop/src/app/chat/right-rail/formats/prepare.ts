import { officeDocumentKind } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { localPreviewTarget } from '@/lib/local-preview'
import { isWindowsAbsolutePath } from '@/lib/path-compare'
import { $connection } from '@/store/session'

import { previewFormat } from './kinds'
import { preloadFormat } from './registry'

/** 卡片出现后只准备本机 Word/PPT；连接变化或卸载撤销自己尚未开始的工作。 */
export function usePreparePreview(target: string, cwd: string): void {
  const connection = useStore($connection)
  useEffect(() => {
    const file = localPreviewTarget(target, cwd)

    if (file?.kind !== 'file' || !file.path) {
      return
    }

    const path = file.path
    const desktop = window.hermesDesktop
    const requestId = crypto.randomUUID()
    const kind = officeDocumentKind(path)

    const prepare =
      connection?.mode !== 'remote' &&
      typeof desktop?.prepareOfficePreview === 'function' &&
      (path.startsWith('/') || isWindowsAbsolutePath(path)) &&
      (kind === 'word' || kind === 'slides')

    if (prepare) {
      void desktop.prepareOfficePreview(path, requestId).catch(() => undefined)
    }

    /** 模块只在空闲时加载，不读文件内容，也不自动打开右侧面板。 */
    const preload = () => {
      const format = previewFormat(file)

      if (format) {
        void preloadFormat(format, path).catch(() => undefined)
      }
    }

    const idle = typeof window.requestIdleCallback === 'function'
    const task = idle ? window.requestIdleCallback(preload, { timeout: 2000 }) : window.setTimeout(preload, 500)

    return () => {
      if (idle) {
        window.cancelIdleCallback(task)
      } else {
        window.clearTimeout(task)
      }

      if (prepare) {
        void desktop.cancelOfficePreview(requestId).catch(() => undefined)
      }
    }
  }, [target, cwd, connection])
}
