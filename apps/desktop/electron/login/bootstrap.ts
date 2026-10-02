import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { app, BrowserWindow, dialog } from 'electron'

import { resolveDesktopUserData } from '../data-paths'
import { createWindowOpenHandler } from '../window-open-policy'

let loginWindow: BrowserWindow | null = null
let starting: Promise<BrowserWindow | null> | null = null
let stopping = false
let initialized = false

// P04 将此阶段说明替换为登录 Renderer；此处没有聊天入口或原版 preload。
const preparationPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark">
<title>Hermes Desktop MT</title></head>
<body><main><h1>Hermes Desktop MT</h1>
<p role="status">账号登录功能正在接入，本地 Hermes 尚未启动。</p>
<p>当前为分阶段开发版本，暂不能登录或进入聊天。可以直接关闭窗口退出。</p>
</main></body></html>`

/** 初始化应用级目录与退出事件，不读取任何账号 Home 或旧连接。 */
function initializeLoginShell(): void {
  if (initialized) {
    return
  }

  initialized = true
  app.setName('Hermes Desktop MT')
  const userData = resolveDesktopUserData(path.join(app.getPath('appData'), 'HermesDesktopMT'))
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  app.on('before-quit', () => {
    stopping = true
  })
  app.on('window-all-closed', () => app.quit())
  app.on('second-instance', () => {
    if (!loginWindow || stopping) {
      return
    }

    if (loginWindow.isMinimized()) {
      loginWindow.restore()
    }

    loginWindow.focus()
  })

  if (!app.requestSingleInstanceLock()) {
    stopping = true
    app.quit()
  }
}

/** 创建无文件／进程桥接能力的登录窗口，关闭即取消本次启动。 */
async function openLoginWindow(): Promise<BrowserWindow | null> {
  await app.whenReady()

  if (stopping) {
    return null
  }

  const window = new BrowserWindow({
    width: 640,
    height: 480,
    minWidth: 400,
    minHeight: 300,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      partition: 'desktop-mt-login'
    }
  })

  loginWindow = window
  window.removeMenu()
  window.webContents.setWindowOpenHandler(createWindowOpenHandler())
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.on('closed', () => {
    loginWindow = null
    stopping = true
    app.quit()
  })
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(preparationPage)}`)

  if (stopping || window.isDestroyed()) {
    return null
  }

  window.show()

  return window
}

/** 合并重复启动请求；未获可信身份前只启动登录壳，不导入账号运行时。 */
export function startDesktopLogin(): Promise<BrowserWindow | null> {
  initializeLoginShell()

  if (stopping) {
    return Promise.resolve(null)
  }

  if (starting) {
    return starting
  }

  starting = openLoginWindow().catch(() => {
    if (!stopping) {
      dialog.showErrorBox('Hermes Desktop MT', '登录窗口无法打开，请关闭后重试。')
      app.exit(1)
    }

    return null
  })

  return starting
}
