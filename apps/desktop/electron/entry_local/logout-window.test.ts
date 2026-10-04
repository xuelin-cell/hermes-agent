import { expect, it, vi } from 'vitest'

const { created, windows } = vi.hoisted(() => ({ created: new Map(), windows: new Set() }))
vi.mock('electron', () => {
  /** 模拟窗口创建事件发生在构造器返回之前，不替代真实 Electron 故障验收。 */
  class BrowserWindow {
    destroyed = false
    removeMenu = vi.fn()
    loadURL = vi.fn(async () => {})
    on = vi.fn()

    /** 新窗口先进入原生创建事件，再向调用者返回。 */
    constructor() {
      windows.add(this)
      created.get('browser-window-created')?.({}, this)
    }

    /** 等待窗与新窗口只通过已完成构造的实例收尾。 */
    destroy() {
      this.destroyed = true
      windows.delete(this)
    }

    /** 查询实际生命周期，容许其他关闭路径先结束窗口。 */
    isDestroyed() {
      return this.destroyed
    }

    /** 取当前窗口，不保留已销毁实例。 */
    static getAllWindows() {
      return [...windows]
    }
  }

  return {
    app: { on: vi.fn((name, callback) => created.set(name, callback)) },
    BrowserWindow,
    dialog: {},
    globalShortcut: { unregisterAll: vi.fn() },
    Menu: { setApplicationMenu: vi.fn() }
  }
})

import { BrowserWindow } from 'electron'

import { openLogoutWindow } from './logout-window'

it('退出中的新窗口在构造返回后才销毁，保留等待窗，已关闭的新窗口不重复处理', async () => {
  const waiting = openLogoutWindow()
  const extra = new BrowserWindow()
  const alreadyClosed = new BrowserWindow()
  alreadyClosed.destroy()
  expect(extra.isDestroyed()).toBe(false)
  await Promise.resolve()
  expect(extra.isDestroyed()).toBe(true)
  expect(waiting.isDestroyed()).toBe(false)
  expect(BrowserWindow.getAllWindows()).toEqual([waiting])
})
