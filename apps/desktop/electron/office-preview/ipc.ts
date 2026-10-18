import { ipcMain, type IpcMainInvokeEvent, type Session } from 'electron'

import { officeDocumentKind, type OfficePreviewResult } from '../../../shared/src/office-preview'
import { isDesktopRendererSender } from '../desktop-renderer-sender'
import { resolveIpcFileReadPath } from '../local-read-path'

import type { createOfficePreviewService } from './service'

/** 只接受固定账号桌面主框架的路径请求；不给登录壳或预览网页转换能力。 */
export function installOfficePreviewIpc(
  session: Session,
  rendererUrl: () => string,
  active: () => boolean,
  service: ReturnType<typeof createOfficePreviewService>
): void {
  /** 与账号 IPC 共用同一套来源校验，并要求当前账号仍处于活动状态。 */
  function trusted(event: IpcMainInvokeEvent): boolean {
    return active() && isDesktopRendererSender(event, session, rendererUrl())
  }

  // 请求编号只在发起页面内有效；键里带上发送方，别的页面无法取消它。
  const requests = new Map<string, AbortController>()

  /** 请求编号由页面生成，只接受短的普通字符串，不能携带路径或账号信息。 */
  function requestKey(event: IpcMainInvokeEvent, requestId: unknown): string | null {
    return typeof requestId === 'string' && /^[\w-]{1,64}$/.test(requestId) ? `${event.sender.id}:${requestId}` : null
  }

  ipcMain.handle('hermes:office-preview:convert', async (event, ...args): Promise<OfficePreviewResult | undefined> => {
    const key = args.length >= 2 ? requestKey(event, args[1]) : null
    const background = args[2] === 'background'

    if (
      !trusted(event) ||
      (args.length !== 1 && !key) ||
      args.length > 3 ||
      (args.length === 3 && !background) ||
      typeof args[0] !== 'string' ||
      !args[0].trim() ||
      (background && !['word', 'slides'].includes(officeDocumentKind(args[0]) || ''))
    ) {
      return { ok: false, code: 'unsupported' }
    }

    const controller = new AbortController()

    if (key) {
      requests.set(key, controller)
    }

    try {
      const result = await service.convert(resolveIpcFileReadPath(args[0]), controller.signal, background)

      // 预准备只填充账号缓存，不把可能很大的 PDF 字节传回每张卡片。
      if (background) {
        return
      }

      return trusted(event) ? result : { ok: false, code: 'unavailable' }
    } catch {
      return { ok: false, code: 'convert_failed' }
    } finally {
      if (key && requests.get(key) === controller) {
        requests.delete(key)
      }
    }
  })

  // 页面离开时取消自己的请求：还在排队的转换没人等了就跳过，已经开始的照常完成并进缓存。
  ipcMain.handle('hermes:office-preview:cancel', (event, ...args): void => {
    const key = args.length === 1 && trusted(event) ? requestKey(event, args[0]) : null

    if (key) {
      requests.get(key)?.abort()
      requests.delete(key)
    }
  })
}
