import { BrowserWindow, ipcMain, type Session } from 'electron'

import type { LoginAccount } from './contract'

/** 仅向当前账号桌面的主框架提供只读展示信息，不接受页面身份参数。 */
export function installAccountIpc(
  session: Session,
  rendererUrl: () => string,
  readAccount: () => LoginAccount | null
): void {
  ipcMain.handle('hermes:maas-account:get', (event, ...args): LoginAccount | null => {
    const window = BrowserWindow.fromWebContents(event.sender)

    if (
      args.length ||
      !window ||
      window.isDestroyed() ||
      window.webContents !== event.sender ||
      event.sender.session !== session ||
      event.senderFrame !== event.sender.mainFrame ||
      !event.senderFrame
    ) {
      return null
    }

    try {
      const actual = new URL(event.senderFrame.url)
      const expected = new URL(rendererUrl())

      // 同一桌面的副窗通过查询参数和 hash 路由区分，不允许其他页面或来源。
      actual.search = expected.search = ''
      actual.hash = expected.hash = ''

      if (actual.href !== expected.href) {
        return null
      }

      const account = readAccount()

      return account && account.expiresAt > Date.now()
        ? { maskedPhone: account.maskedPhone, expiresAt: account.expiresAt }
        : null
    } catch {
      return null
    }
  })
}
