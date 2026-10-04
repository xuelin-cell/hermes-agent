import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { app, BrowserWindow, dialog, net } from 'electron'

import { platformDefaultHermesHome, resolveDesktopUserData } from '../data-paths'
import { markDesktopLaunchSuccessful, prepareDesktopLaunch } from '../desktop-launch'
import { startAccountDesktop } from '../entry_local/desktop-runtime'
import { recoverAccountRun } from '../entry_local/recover-account'
import { LocalRuntimeContext, type PreparedLocalContext } from '../entry_local/runtime-context'
import { LocalStartupError, showLocalStartupFailure } from '../entry_local/startup-failure'
import { createWindowOpenHandler } from '../window-open-policy'

import type { LoginAccount } from './contract'
import { CredentialStore } from './credential-store'
import { installLoginIpc } from './ipc'
import { LoginSession } from './session'

let loginWindow: BrowserWindow | null = null
let starting: Promise<BrowserWindow | null> | null = null
let stopping = false
let initialized = false
let accountRuntime: LocalRuntimeContext | null = null
let desktopStarting: Promise<void> | null = null
let handedOff = false
let startupFailed = false
let recovery: Promise<void> | null = null

/** 先取得单实例锁，再安排上次账号清理；完成前不开放登录或桌面。 */
function initializeLoginShell(): void {
  if (initialized) {
    return
  }

  initialized = true
  app.setName('Hermes Desktop MT')
  const userData = resolveDesktopUserData(path.join(app.getPath('appData'), 'HermesDesktopMT'))
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  prepareDesktopLaunch()

  if (!app.requestSingleInstanceLock()) {
    stopping = true
    app.quit()

    return
  }

  const roots = {
    data: platformDefaultHermesHome(app.getPath('home'), { ...process.env, HERMES_DATA_DIR_SUFFIX: '-desktop-mt' }),
    userData
  }

  const installationRoot = process.env.HERMES_DESKTOP_HERMES_ROOT || path.resolve(app.getAppPath(), '../..')
  recovery = app
    .whenReady()
    .then(() => recoverAccountRun(roots, installationRoot, process.env.HERMES_DESKTOP_PYTHON))
    .catch(() => {
      stopping = true
      dialog.showErrorBox(
        'Hermes Desktop MT',
        '上次账号工作未能安全收尾，已阻止恢复登录。记录和历史已保留，请寻求支持。'
      )
      app.quit()
    })
  accountRuntime = new LocalRuntimeContext(
    new LoginSession(net.fetch, new CredentialStore(userData)),
    roots,
    installationRoot,
    process.env.HERMES_DESKTOP_PYTHON
  )
  app.on('before-quit', () => {
    if (!handedOff) {
      stopping = true
    }

    markDesktopLaunchSuccessful()
  })
  app.on('will-quit', () => {
    stopping = true
    markDesktopLaunchSuccessful()
    accountRuntime?.dispose()
  })
  app.on('window-all-closed', () => {
    if (!handedOff) {
      app.quit()
    }
  })
  app.on('second-instance', () => {
    if (!loginWindow || stopping) {
      return
    }

    if (loginWindow.isMinimized()) {
      loginWindow.restore()
    }

    loginWindow.focus()
  })
}

/** 创建无文件／进程桥接能力的登录窗口，关闭即取消本次启动。 */
async function openLoginWindow(): Promise<BrowserWindow | null> {
  await app.whenReady()
  await recovery

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

    if (!handedOff) {
      stopping = true
      app.quit()
    }
  })
  installLoginIpc(window, expectedUrl, accountRuntime!.login, () => {
    if (stopping || startupFailed) {
      return
    }

    try {
      const context = accountRuntime!.prepare()
      desktopStarting ??= startAccountDesktop(context)
        .then(() => {
          if (stopping || window.isDestroyed()) {
            return
          }

          handedOff = true
          window.destroy()
        })
        .catch(error => {
          // 不回退旧环境，不在半初始化的主进程中重复安装原版事件和 IPC。
          if (!stopping && !window.isDestroyed()) {
            startupFailed = true
            showLocalStartupFailure(new LocalStartupError('runtime', error), window)
          }
        })
    } catch (error) {
      // 不把文件系统路径、账号标识或原始异常交给页面。
      startupFailed = true
      showLocalStartupFailure(
        error instanceof LocalStartupError ? error : new LocalStartupError('runtime', error),
        window
      )
    }
  })

  if (devServer) {
    await window.loadURL(new URL('/login.html', devServer).href)
  } else {
    await window.loadFile(path.join(app.getAppPath(), 'dist', 'login.html'))
  }

  if (stopping || window.isDestroyed()) {
    return null
  }

  window.show()
  markDesktopLaunchSuccessful()

  return window
}

/** 向后续启动流程交接固定上下文；不新增页面 IPC 或提前加载原版主进程。 */
export function currentDesktopLocalContext(): PreparedLocalContext | null {
  return stopping ? null : (accountRuntime?.current() ?? null)
}

/** 展示本次已准备账号，即使登录到期也保留手动退出入口；不恢复身份。 */
export function currentDesktopAccount(): LoginAccount | null {
  return stopping ? null : (accountRuntime?.currentAccount() ?? null)
}

/** 退出确认后立即撤销主进程身份，不再允许读取或准备旧账号。 */
export function sealDesktopAccount(): void {
  stopping = true
  accountRuntime?.dispose()
}

/** 合并重复启动请求；未获可信身份前只启动登录壳，不导入账号运行时。 */
export function startDesktopLogin(): Promise<BrowserWindow | null> {
  try {
    initializeLoginShell()
  } catch (error) {
    stopping = true
    void app.whenReady().then(() => showLocalStartupFailure(new LocalStartupError('directory', error)))

    return Promise.resolve(null)
  }

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
