import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { app, BrowserWindow, dialog, globalShortcut, Menu } from 'electron'

import { wireWindowReveal } from '../window-reveal'

import type { AccountExitMode } from './logout'

/** 区分注销等待和完整退出；先隐藏，取得进程快照后才销毁旧页面与 PTY。 */
export function createAccountExitWindows(options: {
  background: () => string
  dark: () => boolean
  bounds?: () => Electron.Rectangle | undefined
}) {
  let mode: AccountExitMode | null = null
  let captured = false
  let waiting: BrowserWindow | null = null
  let bounds: Electron.Rectangle | undefined

  /** 故障页与注销页共用纯展示入口，不授予登录、文件或进程桥接。 */
  function showWaiting(): BrowserWindow {
    if (waiting) {
      return waiting
    }

    const background = options.background()

    const window = new BrowserWindow({
      ...bounds,
      width: bounds?.width ?? 640,
      height: bounds?.height ?? 480,
      title: 'Hermes',
      backgroundColor: background,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'desktop-mt-exit'
      }
    })

    waiting = window
    window.removeMenu()
    window.on('close', event => event.preventDefault())
    wireWindowReveal(window)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false))
    window.webContents.session.setPermissionCheckHandler(() => false)

    const devServer = process.env.HERMES_DESKTOP_DEV_SERVER

    const url = new URL(
      devServer
        ? new URL('/login.html', devServer).href
        : pathToFileURL(path.join(app.getAppPath(), 'dist', 'login.html')).href
    )

    url.searchParams.set('exit', '1')
    url.searchParams.set('background', background)
    url.searchParams.set('dark', options.dark() ? '1' : '0')
    void window.loadURL(url.href)

    return window
  }

  /** 快照之前只隐藏旧窗口，避免销毁 PTY 时丢失账号进程归属。 */
  function retireOldWindows(): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window !== waiting) {
        if (captured) {
          window.destroy()
        } else {
          window.hide()
        }
      }
    }
  }

  return {
    /** 持久化退出意图后封闭展示入口；完整退出立即隐藏且不创建等待页。 */
    seal(requested: AccountExitMode): void {
      if (mode) {
        return
      }

      mode = requested
      bounds = options.bounds?.()
      Menu.setApplicationMenu(null)
      globalShortcut.unregisterAll()

      for (const window of BrowserWindow.getAllWindows()) {
        window.on('show', () => {
          if ((mode === 'quit' || waiting) && !window.isDestroyed()) {
            window.hide()
          }
        })
      }

      app.on('browser-window-created', (_event, window) => {
        // 等构造完成后再销毁新窗口；受控等待页是唯一例外。
        queueMicrotask(() => {
          if (window !== waiting && !window.isDestroyed()) {
            window.destroy()
          }
        })
      })

      if (mode === 'quit') {
        retireOldWindows()
      }
    },
    /** 取得同一份进程快照后，注销显示官方风格等待页，再销毁旧页面。 */
    afterSnapshot(): void {
      captured = true

      if (mode === 'logout') {
        showWaiting()
      }

      retireOldWindows()
    },
    /** 停止失败才恢复可见的故障窗口；重试期间仍不放行原账号页面。 */
    failure(): BrowserWindow {
      const window = showWaiting()
      retireOldWindows()

      return window
    },
    /** 收尾成功后允许等待窗关闭，注销仍沿用 Electron 重启流程。 */
    finish(): void {
      waiting?.removeAllListeners('close')
    }
  }
}

/** 清理失败保留等待窗；只允许重试或结束应用，不放行另一个账号。 */
export async function retryLogout(window: BrowserWindow, run: () => Promise<void>): Promise<void> {
  for (;;) {
    const { response } = await dialog.showMessageBox(window, {
      type: 'error',
      title: 'Hermes Desktop MT',
      message: '退出尚未完成，已禁止切换账号。历史和进程归属记录均保留。',
      detail: '请重试。若关闭应用，下次启动仍会阻止登录，直到遗留停止意图得到处理。',
      buttons: ['重试', '关闭应用'],
      defaultId: 0,
      cancelId: 1
    })

    if (response === 1) {
      app.exit(1)

      return
    }

    try {
      await run()

      return
    } catch {
      /* 停止失败不恢复账号或吞掉退出意图。 */
    }
  }
}
