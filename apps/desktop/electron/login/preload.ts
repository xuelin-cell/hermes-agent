import { contextBridge, ipcRenderer } from 'electron'

import { CAPTCHA_CHANNEL, type DesktopLoginBridge, LOGIN_CHANNEL, RESTORE_CHANNEL, SEND_SMS_CHANNEL } from './contract'

const bridge: DesktopLoginBridge = {
  /** 恢复只读取主进程记录，不接受页面提供的 UID、token 或文件路径。 */
  restore: () => ipcRenderer.invoke(RESTORE_CHANNEL),
  /** 请求验证码，不暴露通用 IPC 或原版文件与进程能力。 */
  captcha: () => ipcRenderer.invoke(CAPTCHA_CHANNEL),
  /** 发送短信所需字段，不能指定上游地址、请求头或身份。 */
  sendSms: input => ipcRenderer.invoke(SEND_SMS_CHANNEL, input),
  /** 登录只返回受控展示结果，不暴露主进程保存的凭据。 */
  login: input => ipcRenderer.invoke(LOGIN_CHANNEL, input)
}

contextBridge.exposeInMainWorld('hermesLogin', bridge)
