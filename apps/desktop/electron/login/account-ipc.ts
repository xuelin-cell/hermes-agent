import { ipcMain, type IpcMainInvokeEvent, type Session } from 'electron'

import { isDesktopRendererSender } from '../desktop-renderer-sender'

import { ASR_CHANNEL, type AsrIdentity } from '../uniwork-asr/contract'
import { createUniworkAsrHandler } from '../uniwork-asr/ipc'

import { WELCOME_CATALOG_CHANNEL } from '../uniwork-welcome/catalog'
import { WelcomeCatalogClient } from '../uniwork-welcome/client'

import { CloudDriveClient } from './cloud-drive'
import type { LoginAccount } from './contract'
import type { LoginIdentity } from './session'

/** 仅向当前账号桌面的主框架提供只读展示信息，不接受页面身份参数。 */
export function installAccountIpc(
  session: Session,
  rendererUrl: () => string,
  readAccount: () => LoginAccount | null,
  logout?: () => Promise<void>,
  readIdentity?: () => LoginIdentity | null,
  readAsrIdentity?: () => AsrIdentity | null
): void {
  /** 展示与退出共用来源校验，不接收 UID、路径或进程号。 */
  function trusted(event: IpcMainInvokeEvent, args: unknown[]): boolean {
    return !args.length && isDesktopRendererSender(event, session, rendererUrl())
  }

  if (readAsrIdentity) {
    const asr = createUniworkAsrHandler(readAsrIdentity)
    ipcMain.handle(ASR_CHANNEL, async (event, ...args) => {
      if (!trusted(event, []) || args.length !== 1) {
        throw new Error('语音识别请求无效。')
      }
      return asr(event, args[0])
    })
  }

  if (logout) {
    ipcMain.handle('hermes:maas-account:logout', async (event, ...args): Promise<void> => {
      if (!trusted(event, args) || !readAccount()) {
        throw new Error('退出请求无效。')
      }

      await logout()
    })
  }

  if (readIdentity) {
    const catalog = new WelcomeCatalogClient(readIdentity)
    ipcMain.handle(WELCOME_CATALOG_CHANNEL, async (event, ...args) => {
      if (!trusted(event, []) || args.length !== 1 || !['zh-CN', 'en'].includes(args[0])) {
        throw new Error('办公模板请求无效。')
      }
      return catalog.load(args[0])
    })
    const drive = new CloudDriveClient(readIdentity)
    ipcMain.handle('hermes:maas-drive:request', async (event, ...args) => {
      if (!trusted(event, []) || args.length !== 1 || !readIdentity()) {
        throw new Error('云盘请求无效')
      }

      try {
        return await drive.execute(args[0])
      } catch (error) {
        throw new Error(
          error instanceof Error && /^(请|个人云盘|云盘|登录)/.test(error.message)
            ? error.message
            : '个人云盘请求失败，请重试'
        )
      }
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
