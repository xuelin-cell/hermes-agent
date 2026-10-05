import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { _electron as electron } from '@playwright/test'
import electronPath from 'electron'
import { build } from 'esbuild'

import { prepareLoginRenderer } from './login-renderer.fixture.mjs'

const desktop = path.resolve(import.meta.dirname, '..')

/** 构建只包含窗口控制器的真实 Electron 夹具，不启动后端或读取用户账号。 */
async function prepare(mode) {
  const renderer = await prepareLoginRenderer()
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-exit-window-'))
  const output = path.join(root, 'entry.mjs')
  await build({ stdin: { resolveDir: desktop, contents: `
    import assert from 'node:assert/strict'
    import { app, BrowserWindow } from 'electron'
    import { createAccountExitWindows } from './electron/entry_local/logout-window'
    app.setAppPath(${JSON.stringify(renderer)})
    app.setPath('userData', ${JSON.stringify(root)})
    app.on('window-all-closed', () => {})
    globalThis.fixtureQuitHold = true
    app.on('before-quit', event => { if (globalThis.fixtureQuitHold) event.preventDefault() })
    // 夹具显示但不激活窗口，避免抢走用户当前窗口的焦点。
    BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive
    app.whenReady().then(async () => {
    const old = new BrowserWindow({ show: false, width: 800, height: 560 })
    await old.loadURL('data:text/html,<p>fixture old window</p>')
    old.showInactive()
    const mode = ${JSON.stringify(mode)}
    const controller = createAccountExitWindows({
      background: () => mode.includes('dark') ? '#111111' : '#f7f7f7',
      dark: () => mode.includes('dark'), bounds: () => old.getBounds()
    })
    controller.seal(mode.startsWith('quit') ? 'quit' : 'logout')
    assert.equal(old.isDestroyed(), false)
    if (mode.startsWith('quit')) assert.equal(old.isVisible(), false)
    if (mode === 'quit-failure') {
      controller.failure()
      assert.equal(old.isDestroyed(), false)
      assert.equal(old.isVisible(), false)
    } else {
      controller.afterSnapshot()
      assert.equal(old.isDestroyed(), true)
    }
    globalThis.fixtureExit = { controller, old }
    }).catch(error => { console.error(error); app.exit(1) })
  ` }, outfile: output, bundle: true, platform: 'node', format: 'esm', external: ['electron'] })
  const env = { ...process.env }
  delete env.HERMES_DESKTOP_DEV_SERVER

  return { output, root, env }
}

for (const mode of ['logout-light', 'logout-dark', 'quit', 'quit-failure']) {
  test(`真实 Electron 退出展示：${mode}`, { timeout: 240_000 }, async () => {
    const fixture = await prepare(mode)
    console.log(`退出展示夹具：${fixture.root}`)
    let instance
    try {
      instance = await electron.launch({ executablePath: electronPath, args: [fixture.output], env: fixture.env })
      await instance.evaluate(async () => {
        for (let tries = 0; tries < 300; tries++) {
          if (globalThis.fixtureExit) return
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error('退出窗口夹具未就绪')
      })
      if (mode === 'quit') {
        assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0)
        return
      }
      let waiting
      for (let tries = 0; tries < 100 && !waiting; tries++) {
        waiting = instance.windows().find(page => new URL(page.url()).searchParams.get('exit') === '1')
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.ok(waiting)
      await waiting.getByRole('status').waitFor()
      await waiting.waitForFunction(() => document.querySelector('.decode-cursor-blink'))
      await instance.evaluate(async ({ BrowserWindow }) => {
        for (let tries = 0; tries < 300; tries++) {
          if (BrowserWindow.getAllWindows().some(window => window.webContents.getURL().includes('exit=1') && window.isVisible())) return
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error('等待页首帧后窗口未显示')
      })
      const display = await waiting.evaluate(() => ({
        background: getComputedStyle(document.querySelector('[role=status]')).backgroundColor,
        text: document.querySelector('[role=status]').textContent,
        dark: document.documentElement.classList.contains('dark'),
        bridge: [typeof window.hermesDesktop, typeof window.hermesLogin, typeof window.require],
        controls: document.querySelectorAll('button,input,textarea').length
      }))
      assert.equal(display.background, mode.includes('dark') ? 'rgb(17, 17, 17)' : 'rgb(247, 247, 247)')
      assert.equal(display.dark, mode.includes('dark'))
      assert.deepEqual(display.bridge, ['undefined', 'undefined', 'undefined'])
      assert.equal(display.controls, 0)
      assert.ok(display.text.includes('退出账号') || display.text.includes('Signing out'))
      await waiting.screenshot({ path: path.join(fixture.root, `${mode}.png`) })
      if (mode === 'quit-failure') {
        const windows = await instance.evaluate(({ app, BrowserWindow }) => {
          const { controller, old } = globalThis.fixtureExit
          const waiting = controller.failure()
          app.quit()
          const visibleAfterQuit = waiting.isVisible()
          controller.afterSnapshot()

          return { oldDestroyed: old.isDestroyed(), waitingDestroyed: waiting.isDestroyed(), visibleAfterQuit, count: BrowserWindow.getAllWindows().length }
        })
        assert.deepEqual(windows, { oldDestroyed: true, waitingDestroyed: false, visibleAfterQuit: true, count: 1 })
      }
    } finally {
      await instance?.evaluate(() => {
        globalThis.fixtureQuitHold = false
        globalThis.fixtureExit.controller.finish()
      }).catch(() => {})
      await instance?.close()
    }
  })
}
