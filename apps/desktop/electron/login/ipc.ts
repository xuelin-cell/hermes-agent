import { type BrowserWindow, ipcMain, net } from 'electron'

import { fetchCaptcha } from './captcha'
import { CAPTCHA_CHANNEL, type CaptchaResult } from './contract'

/** 只接收当前登录窗口主框架的无参数请求，窗口关闭时移除能力。 */
export function installCaptchaIpc(window: BrowserWindow, expectedUrl: string): void {
  ipcMain.handle(CAPTCHA_CHANNEL, async (event, ...args): Promise<CaptchaResult> => {
    if (
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== expectedUrl ||
      args.length > 0
    ) {
      return { ok: false }
    }

    return fetchCaptcha(net.fetch)
  })
  window.once('closed', () => ipcMain.removeHandler(CAPTCHA_CHANNEL))
}
