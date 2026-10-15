import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type Session } from 'electron'

import type { OfficePreviewResult } from '../../../shared/src/office-preview'
import { resolveIpcFileReadPath } from '../local-read-path'

import type { createOfficePreviewService } from './service'

/** 只接受固定账号桌面主框架的路径请求；不给登录壳或预览网页转换能力。 */
export function installOfficePreviewIpc(
  session: Session,
  rendererUrl: () => string,
  active: () => boolean,
  service: ReturnType<typeof createOfficePreviewService>
): void {
  /** 沿用账号 IPC 的分区、窗口和页面校验，允许桌面副窗的路由参数。 */
  function trusted(event: IpcMainInvokeEvent): boolean {
    const window = BrowserWindow.fromWebContents(event.sender)

    if (
      !active() ||
      !window ||
      window.isDestroyed() ||
      event.sender.session !== session ||
      event.senderFrame !== event.sender.mainFrame ||
      !event.senderFrame
    ) {
      return false
    }

    try {
      const actual = new URL(event.senderFrame.url)
      const expected = new URL(rendererUrl())
      actual.search = expected.search = ''
      actual.hash = expected.hash = ''

      return actual.href === expected.href
    } catch {
      return false
    }
  }

  ipcMain.handle('hermes:office-preview:convert', async (event, ...args): Promise<OfficePreviewResult> => {
    if (!trusted(event) || args.length !== 1 || typeof args[0] !== 'string' || !args[0].trim()) {
      return { ok: false, code: 'unsupported' }
    }

    try {
      const result = await service.convert(resolveIpcFileReadPath(args[0]))

      return trusted(event) ? result : { ok: false, code: 'unavailable' }
    } catch {
      return { ok: false, code: 'convert_failed' }
    }
  })
}
