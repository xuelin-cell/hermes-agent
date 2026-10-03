import { app, BrowserWindow, dialog, globalShortcut, Menu } from 'electron'

/** 封闭所有旧页面及其连接；等待窗不带 preload，也不授予文件或进程桥接。 */
export function openLogoutWindow(): BrowserWindow {
  const previous = BrowserWindow.getAllWindows()

  const window = new BrowserWindow({
    width: 480,
    height: 220,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })

  window.removeMenu()
  Menu.setApplicationMenu(null)
  globalShortcut.unregisterAll()
  void window.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<!doctype html><meta charset="utf-8"><title>Hermes Desktop MT</title><p>正在退出账号，请稍候… / Signing out…</p>'
      )
  )
  window.on('close', event => event.preventDefault())
  app.on('browser-window-created', (_event, other) => {
    other.destroy()
  })

  for (const old of previous) {
    old.destroy()
  }

  return window
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
