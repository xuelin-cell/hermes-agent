import { EventEmitter } from 'node:events'

import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ windows: [] as any[], app: { on: vi.fn() }, menu: vi.fn(), shortcuts: vi.fn() }))
vi.mock('electron', () => ({
  app: Object.assign(state.app, { getAppPath: () => 'C:/fixture' }),
  Menu: { setApplicationMenu: state.menu },
  globalShortcut: { unregisterAll: state.shortcuts },
  dialog: {},
  BrowserWindow: class extends EventEmitter {
    /** 只返回未销毁的夹具窗口。 */
    static getAllWindows() {
      return state.windows.filter(window => !window.destroyed)
    }
    destroyed = false
    visible: boolean
    options: any
    url = ''
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
    }
    /** 创建事件发生在构造返回前，用于验证延迟销毁的新窗门禁。 */
    constructor(options: any) {
      super()
      this.options = options
      this.visible = options.show !== false
      state.windows.push(this)

      for (const [event, callback] of state.app.on.mock.calls) {
        if (event === 'browser-window-created') {
          callback(null, this)
        }
      }
    }
    /** 模拟窗口隐藏，不销毁 PTY 所属上下文。 */
    hide() {
      this.visible = false
    }
    /** 首帧就绪时显示夹具等待页。 */
    show() {
      this.visible = true
    }
    /** 标记夹具窗口已销毁。 */
    destroy() {
      this.destroyed = true
    }
    /** 返回当前销毁状态。 */
    isDestroyed() {
      return this.destroyed
    }
    /** 供原版首帧显示控制器检查窗口可见性。 */
    isVisible() {
      return this.visible
    }
    /** 夹具没有原生菜单。 */
    removeMenu() {}
    /** 记录目标地址，不加载真实网页。 */
    loadURL(url: string) {
      this.url = url

      return Promise.resolve()
    }
  }
}))

import { BrowserWindow } from 'electron'

import { createAccountExitWindows } from './logout-window'

beforeEach(() => {
  state.windows = []
  vi.clearAllMocks()
})

/** 使用只有窗口行为的夹具验证隐藏与销毁顺序，不操作系统桌面。 */
function fixture() {
  const old = new BrowserWindow({}) as any
  const controller = createAccountExitWindows({ background: () => '#111111', dark: () => true })

  return { old, controller }
}

it('完整退出先隐藏但不销毁，快照取得后销毁旧窗；正常不创建等待窗', () => {
  const { old, controller } = fixture()
  controller.seal('quit')
  expect(old.visible).toBe(false)
  expect(old.destroyed).toBe(false)
  expect(state.windows).toHaveLength(1)
  old.visible = true
  old.emit('show')
  expect(old.visible).toBe(false)
  controller.afterSnapshot()
  expect(old.destroyed).toBe(true)
  expect(state.windows).toHaveLength(1)
})

it('退出账号在快照后打开同款纯展示页；禁止桥接、导航和新账号窗口', async () => {
  const { old, controller } = fixture()
  controller.seal('logout')
  expect(old.visible).toBe(true)
  controller.afterSnapshot()
  const waiting = state.windows[1]
  expect(old.destroyed).toBe(true)
  expect(new URL(waiting.url).searchParams.get('exit')).toBe('1')
  expect(new URL(waiting.url).searchParams.get('background')).toBe('#111111')
  expect(waiting.options.webPreferences.preload).toBeUndefined()
  expect(waiting.options.webPreferences.nodeIntegration).toBe(false)
  expect(waiting.options.webPreferences.partition).toBe('desktop-mt-exit')
  expect(waiting.visible).toBe(false)
  waiting.emit('ready-to-show')
  expect(waiting.visible).toBe(true)
  expect(waiting.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
  expect(waiting.webContents.session.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false)
  const extra = new BrowserWindow({}) as any
  await Promise.resolve()
  expect(extra.destroyed).toBe(true)
  const event = { preventDefault: vi.fn() }
  waiting.emit('close', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  controller.finish()
  expect(waiting.listenerCount('close')).toBe(0)
})

it('快照失败时只显示恢复页，不提前销毁旧 PTY；重试成功取得快照后再销毁', async () => {
  const { old, controller } = fixture()
  controller.seal('quit')
  const waiting = controller.failure() as any
  await Promise.resolve()
  expect(waiting.destroyed).toBe(false)
  expect(old.destroyed).toBe(false)
  expect(old.visible).toBe(false)
  controller.afterSnapshot()
  expect(old.destroyed).toBe(true)
  expect(waiting.destroyed).toBe(false)
  expect(controller.failure()).toBe(waiting)
})
