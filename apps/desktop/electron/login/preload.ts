import { contextBridge, ipcRenderer } from 'electron'

import { CAPTCHA_CHANNEL, type DesktopLoginBridge } from './contract'

const bridge: DesktopLoginBridge = {
  /** 页面只能请求验证码，不暴露通用 IPC 或原版文件与进程能力。 */
  captcha: () => ipcRenderer.invoke(CAPTCHA_CHANNEL)
}

contextBridge.exposeInMainWorld('hermesLogin', bridge)
