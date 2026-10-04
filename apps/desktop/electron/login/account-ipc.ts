import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type Session } from 'electron'

import type { LoginAccount } from './contract'

/** 仅向当前账号桌面的主框架提供只读展示信息，不接受页面身份参数。 */
export function installAccountIpc(
  session: Session,
  rendererUrl: () => string,
  readAccount: () => LoginAccount | null,
  logout?: () => Promise<void>
): void {
  /** 展示与退出共用来源校验，不接收 UID、路径或进程号。 */
  function trusted(event: IpcMainInvokeEvent, args: unknown[]): boolean {
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
      return false
    }

    try {
      const actual = new URL(event.senderFrame.url)
      const expected = new URL(rendererUrl())

      // 同一桌面的副窗通过查询参数和 hash 路由区分，不允许其他页面或来源。
      actual.search = expected.search = ''
      actual.hash = expected.hash = ''

      if (actual.href !== expected.href) {
        return false
      }

      return true
    } catch {
      return false
    }
  }

  if (logout) {
    ipcMain.handle('hermes:maas-account:logout', async (event, ...args): Promise<void> => {
      if (!trusted(event, args) || !readAccount()) {
        throw new Error('退出请求无效。')
      }

      await logout()
    })
  }

  ipcMain.handle('hermes:maas-account:get', (event, ...args): LoginAccount | null => {
    if (!trusted(event, args)) {
      return null
    }

    try {
      const account = readAccount()

      return account
        ? {
            maskedPhone: account.maskedPhone,
            expiresAt: account.expiresAt,
            ...(account.planAuthRejected ? { planAuthRejected: true } : {})
          }
        : null
    } catch {
      return null
    }
  })
}
