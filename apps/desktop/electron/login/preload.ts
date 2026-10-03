import { contextBridge, ipcRenderer } from 'electron'

import { CAPTCHA_CHANNEL, type DesktopLoginBridge, SEND_SMS_CHANNEL } from './contract'

const bridge: DesktopLoginBridge = {
  /** 请求验证码，不暴露通用 IPC 或原版文件与进程能力。 */
  captcha: () => ipcRenderer.invoke(CAPTCHA_CHANNEL),
  /** 发送短信所需字段，不能指定上游地址、请求头或身份。 */
  sendSms: input => ipcRenderer.invoke(SEND_SMS_CHANNEL, input)
}

contextBridge.exposeInMainWorld('hermesLogin', bridge)
