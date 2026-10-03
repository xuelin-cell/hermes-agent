import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { app, BrowserWindow, dialog } from 'electron'

import { resolveDesktopUserData } from '../data-paths'
import { createWindowOpenHandler } from '../window-open-policy'

import { installLoginIpc } from './ipc'

let loginWindow: BrowserWindow | null = null
let starting: Promise<BrowserWindow | null> | null = null
let stopping = false
let initialized = false

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

  const devServer = process.env.HERMES_DESKTOP_DEV_SERVER

  const expectedUrl = devServer
    ? new URL('/login.html', devServer).href
    : pathToFileURL(path.join(app.getAppPath(), 'dist', 'login.html')).href

  const window = new BrowserWindow({
    width: 640,
    height: 640,
    minWidth: 400,
    minHeight: 300,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      preload: path.join(app.getAppPath(), 'dist', 'login-preload.js'),
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
  installLoginIpc(window, expectedUrl)

  if (devServer) {
    await window.loadURL(new URL('/login.html', devServer).href)
  } else {
    await window.loadFile(path.join(app.getAppPath(), 'dist', 'login.html'))
  }

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
