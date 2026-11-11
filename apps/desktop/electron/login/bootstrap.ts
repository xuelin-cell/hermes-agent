import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { app, BrowserWindow, dialog, nativeTheme, net, screen } from 'electron'

import {
  bootWindowAppearanceOptions,
  bootWindowBackgroundColor,
  bootWindowStartsMaximized,
  readBootWindowStateFrom
} from '../boot-window-appearance'
import { isWslEnvironment } from '../bootstrap-platform'
import { resolveDesktopUserData } from '../data-paths'
import { markDesktopLaunchSuccessful, prepareDesktopLaunch } from '../desktop-launch'
import { startupMark } from '../desktop-startup-log'
import { accountDataRoot } from '../entry_local/account-paths'
import { enableDesktopPlugins } from '../entry_local/desktop-plugins-config'
import { startAccountDesktop } from '../entry_local/desktop-runtime'
import { installArtifactSharePlugin } from '../entry_local/install-artifact-share'
import { recoverAccountRun } from '../entry_local/recover-account'
import { LocalRuntimeContext, type PreparedLocalContext } from '../entry_local/runtime-context'
import { registerPackagedSkillsCli } from '../entry_local/skills-cli-install'
import { LocalStartupError, showLocalStartupFailure } from '../entry_local/startup-failure'
import { createUniAgentGateBindingUpdate } from '../entry_local/uniagentgate-control'
import { migrateOldUniworkData, migrateOldUniworkToWorkspace } from '../migrate-old-uniwork'
import { readThemeSource } from '../native-theme-source'
import { ensureLoginShellPath } from '../shell-path'
import { desktopPlatformKind, titleBarOverlayOptions } from '../titlebar-overlay-width'
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
/** Plan A 迁移 Promise；登录成功后 Plan B 复制时 await 它。 */
let migrationPromise: Promise<void> | null = null

/** 与主窗一致的标题栏高度（见 main.ts 的 TITLEBAR_HEIGHT）。 */
const TITLEBAR_HEIGHT = 34

/** 与主窗一致的透明覆盖层底色；不透明值会在某些 Electron 版本上退回系统框色。 */
const TITLEBAR_OVERLAY_COLOR = 'rgba(1, 0, 0, 0)'

/**
 * 登录窗的沙箱偏好：只暴露已批准的登录动作，不给文件／进程桥接能力。
 *
 * 写成函数是因为 `app.getAppPath()` 依赖已经初始化的 app；模块加载期求值会在
 * 单实例锁之前就把路径钉死。
 */
function loginWindowPreferences() {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webviewTag: false,
    preload: path.join(app.getAppPath(), 'dist', 'login-preload.js'),
    partition: 'desktop-mt-login'
  }
}

/** 先取得单实例锁，再安排上次账号清理；完成前不开放登录或桌面。 */
function initializeLoginShell(): void {
  if (initialized) {
    return
  }

  initialized = true
  app.setName('元景数字员工')
  // 与账号数据根同名，Local 和 Roaming 两处都是 uniwork。
  const userData = resolveDesktopUserData(path.join(app.getPath('appData'), 'uniwork'))
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  prepareDesktopLaunch()

  // 首次启动时静默迁移老版 UniWork 用户数据（幂等，fire-and-forget）。
  // 保留返回的 Promise，登录成功后 Plan B 复制前需 await 它。
  // Finder/Dock launches have launchd's minimal PATH. Resolve the login shell
  // before Plan A so Homebrew/user-installed limactl is available to Lima migration.
  migrationPromise = ensureLoginShellPath().then(async () => {
    await migrateOldUniworkData(userData)
  })

  if (!app.requestSingleInstanceLock()) {
    stopping = true
    app.quit()

    return
  }

  // 命令注册与登录并行；失败记录原因，保留桌面登录和原账号数据。
  void app.whenReady().then(registerPackagedSkillsCli).catch(error => {
    console.error('[skills-cli] 命令注册失败：', error instanceof Error ? error.message : '未知错误')
  })

  const roots = {
    data: accountDataRoot(app.getPath('home')),
    userData
  }

  startupMark('login shell initialized', `userData=${userData}`)

  const installationRoot = process.env.HERMES_DESKTOP_HERMES_ROOT || path.resolve(app.getAppPath(), '../..')
  recovery = app
    .whenReady()
    .then(() => recoverAccountRun(roots, installationRoot, process.env.HERMES_DESKTOP_PYTHON))
    .catch(error => {
      stopping = true

      // 该弹窗文案是通用的；真实原因（权限/超时/探测失败）不落日志的话
      // 现场无法事后定位，只能靠复现。
      startupMark('account recovery failed', String((error as NodeJS.ErrnoException)?.code ?? ''))
      console.error(
        '[account-recovery] failed:',
        (error as NodeJS.ErrnoException)?.code ?? '',
        error instanceof Error ? error.message : String(error)
      )

      const advice =
        (error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT'
          ? 'Windows 进程状态查询超时，请稍后重新启动应用。'
          : '上次账号工作未能安全收尾，请寻求支持。'

      dialog.showErrorBox('元景数字员工', `${advice}已阻止恢复登录，账号记录和历史已保留。`)
      app.quit()
    })
  accountRuntime = new LocalRuntimeContext(
    new LoginSession(
      net.fetch,
      new CredentialStore(userData),
      createUniAgentGateBindingUpdate(currentDesktopLocalContext)
    ),
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

  startupMark('login window opening')

  const devServer = process.env.HERMES_DESKTOP_DEV_SERVER

  const expectedUrl = devServer
    ? new URL('/login.html', devServer).href
    : pathToFileURL(path.join(app.getAppPath(), 'dist', 'login.html')).href

  // 冷启动首帧的底色/原生标题栏/`prefers-color-scheme` 都跟着 nativeTheme 走，
  // 而主窗读的是同一个 native-theme.json。不在这里先钉住，登录画面就会跟随系统
  // 深浅，与用户选的应用主题对不上。
  nativeTheme.themeSource = readThemeSource(app.getPath('userData'))

  // 账号能本地恢复时，用户不需要看见登录表单——这一路只需要一个承载品牌启动
  // 画面的窗口。它必须与随后出现的主窗同形，否则「销毁登录窗、显示主窗」这个
  // 交接本身就是一次可见跳变（几何、边框、底色任一不同都会闪）。
  const restorable = accountRuntime!.login.restore().ok
  const savedState = restorable ? readBootWindowStateFrom(app.getPath('userData')) : null
  startupMark(`login window mode: ${restorable ? 'boot' : 'interactive'}`)

  const window = restorable
    ? new BrowserWindow({
        ...bootWindowAppearanceOptions({
          savedState,
          displays: screen.getAllDisplays(),
          titleBarOverlay: titleBarOverlayOptions({
            platform: desktopPlatformKind(process.platform, isWslEnvironment()),
            darwinMajor: process.platform === 'darwin' ? Number.parseInt(os.release(), 10) || 0 : 0,
            titlebarHeight: TITLEBAR_HEIGHT,
            color: TITLEBAR_OVERLAY_COLOR,
            dark: nativeTheme.shouldUseDarkColors
          }),
          platform: process.platform,
          titlebarHeight: TITLEBAR_HEIGHT,
          backgroundColor: bootWindowBackgroundColor(nativeTheme.shouldUseDarkColors)
        }),
        show: false,
        autoHideMenuBar: true,
        webPreferences: loginWindowPreferences()
      })
    : new BrowserWindow({
        // 需要人工输入验证码：保留一个可移动、带标题栏的常规窗口，用户能拖动、
        // 关闭它。这一路不追求与主窗同形——用户看到的是表单，不是品牌启动画面。
        width: 1080,
        height: 760,
        minWidth: 400,
        minHeight: 300,
        show: false,
        autoHideMenuBar: true,
        webPreferences: loginWindowPreferences()
      })

  loginWindow = window

  if (restorable && bootWindowStartsMaximized(savedState)) {
    // 与主窗一致：必须在首帧绘制前最大化，等显示后再最大化会播一段可见的
    // 「小窗→全屏」zoom 动画。
    window.maximize()
  }

  window.removeMenu()
  startupMark('login window created')
  window.webContents.setWindowOpenHandler(createWindowOpenHandler())
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.on('closed', () => {
    loginWindow = null

    if (!handedOff) {
      startupMark('login window closed before sign-in')
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
      startupMark('login succeeded', `account=${context.id}`)

      // Plan B：登录成功后，把 Plan A 已迁移的 old_uniwork_data 复制到
      // 当前账号 workspace 下（账号隔离）。await Plan A 的 Promise，
      // fire-and-forget，不阻塞桌面启动。
      void migrateOldUniworkToWorkspace(app.getPath('userData'), context.workspace, {
        planAPromise: migrationPromise
      })

      enableDesktopPlugins(context.home, ['desktop-deliverables'])
      installArtifactSharePlugin(context.home, app.getAppPath())
      startupMark('account desktop starting')
      desktopStarting ??= startAccountDesktop(context, currentDesktopIdentity)
        .then(async () => {
          if (stopping || window.isDestroyed()) {
            return
          }

          // 主窗在 ready-to-show（或兜底计时）之后才真正上屏。先等它可见，再销毁
          // 登录窗——反过来的顺序会在两窗之间露出一帧只有桌面的画面。
          const { whenDesktopWindowRevealed } = await import('../main')
          await whenDesktopWindowRevealed()

          if (stopping || window.isDestroyed()) {
            return
          }

          handedOff = true
          startupMark('account desktop started, closing login window')
          window.destroy()
        })
        .catch(error => {
          // 不回退旧环境，不在半初始化的主进程中重复安装原版事件和 IPC。
          if (!stopping && !window.isDestroyed()) {
            startupFailed = true
            startupMark('account desktop failed to start', error instanceof Error ? error.message : String(error))
            showLocalStartupFailure(new LocalStartupError('runtime', error), window)
          }
        })
    } catch (error) {
      // 不把文件系统路径、账号标识或原始异常交给页面。
      startupFailed = true
      startupMark('account preparation failed', error instanceof Error ? error.message : String(error))
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

  startupMark('login window content loaded')
  window.show()
  startupMark('login window visible')
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

/** 云盘只在主进程读取当前有效身份，不恢复旧 Web 凭据。 */
export function currentDesktopIdentity() {
  return stopping ? null : (accountRuntime?.login.currentIdentity() ?? null)
}

/** 服务端指令要把重新拉到的套餐落盘，只用主进程里的登录会话。 */
export function currentDesktopLogin() {
  return stopping ? null : (accountRuntime?.login ?? null)
}

/** 实时识别只读取当前有效套餐的专用 Key，不交给页面。 */
export function currentDesktopAsrIdentity() {
  const identity = currentDesktopIdentity()
  const result = accountRuntime?.login.currentPlan()

  return identity && result?.status === 'available'
    ? { owner: identity.uid, key: result.plan.apiKey }
    : null
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
      dialog.showErrorBox('元景数字员工', '登录窗口无法打开，请关闭后重试。')
      app.exit(1)
    }

    return null
  })

  return starting
}
