import { app, type BrowserWindow, ipcMain, type IpcMainInvokeEvent, net } from 'electron'

import { fetchCaptcha } from './captcha'
import {
  CAPTCHA_CHANNEL,
  type CaptchaResult,
  LOGIN_CHANNEL,
  type LoginResult,
  PLAN_CHANNEL,
  type PlanResult,
  RESTORE_CHANNEL,
  SEND_SMS_CHANNEL,
  type SmsResult
} from './contract'
import { CredentialStore } from './credential-store'
import { LoginSession } from './session'
import { createSmsSender } from './sms'

/** 绑定登录窗口的验证码和短信能力，关闭窗口时移除处理器。 */
export function installLoginIpc(window: BrowserWindow, expectedUrl: string): void {
  const sendSms = createSmsSender(net.fetch)
  const session = new LoginSession(net.fetch, new CredentialStore(app.getPath('userData')))

  /** 请求必须来自绑定窗口的主框架和准确登录页地址。 */
  function isTrusted(event: IpcMainInvokeEvent): boolean {
    return (
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame.url === expectedUrl
    )
  }

  ipcMain.handle(CAPTCHA_CHANNEL, async (event, ...args): Promise<CaptchaResult> => {
    if (!isTrusted(event) || args.length > 0) {
      return { ok: false }
    }

    return fetchCaptcha(net.fetch)
  })
  ipcMain.handle(SEND_SMS_CHANNEL, (event, ...args): Promise<SmsResult> | SmsResult => {
    if (!isTrusted(event) || args.length !== 1) {
      return { ok: false, error: 'invalid' }
    }

    return sendSms(args[0])
  })
  ipcMain.handle(LOGIN_CHANNEL, (event, ...args): Promise<LoginResult> | LoginResult => {
    if (!isTrusted(event) || args.length !== 1) {
      return { ok: false }
    }

    return session.login(args[0])
  })
  ipcMain.handle(RESTORE_CHANNEL, (event, ...args): LoginResult => {
    if (!isTrusted(event) || args.length > 0) {
      return { ok: false }
    }

    return session.restore()
  })
  ipcMain.handle(PLAN_CHANNEL, (event, ...args): Promise<PlanResult> | PlanResult => {
    if (!isTrusted(event) || args.length > 0) {
      return { status: 'failed' }
    }

    return session.queryPlan()
  })
  window.once('closed', () => {
    session.dispose()
    ipcMain.removeHandler(CAPTCHA_CHANNEL)
    ipcMain.removeHandler(SEND_SMS_CHANNEL)
    ipcMain.removeHandler(LOGIN_CHANNEL)
    ipcMain.removeHandler(RESTORE_CHANNEL)
    ipcMain.removeHandler(PLAN_CHANNEL)
  })
}
