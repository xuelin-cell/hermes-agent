import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'
import electronPath from 'electron'
import { _electron as electron } from '@playwright/test'

const desktop = path.resolve(import.meta.dirname, '..')

/** 构建真实入口和只供测试使用的观察层，所有数据写入独立临时目录。 */
async function launchFixture(cancel = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-mt-login-'))
  const userData = path.join(root, 'desktop-state')
  const home = path.join(root, 'hermes-home')
  await mkdir(userData)
  // 放置旧连接哨兵，验证登录壳既不消费也不覆盖它。
  const oldConnection = '{"mode":"remote","url":"http://127.0.0.1:1"}'
  await writeFile(path.join(userData, 'connection.json'), oldConnection)
  const output = path.join(root, 'fixture.mjs')
  await build({
    stdin: {
      resolveDir: desktop,
      contents: `
        import childProcess from 'node:child_process'
        import { syncBuiltinESMExports } from 'node:module'
        import { app } from 'electron'
        globalThis.loginProbe = { processCalls: [], cancelled: false }
        // 记录真实主进程的启动动作，不替换返回结果或伪造后端状态。
        for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
          const original = childProcess[name]
          childProcess[name] = (...args) => {
            globalThis.loginProbe.processCalls.push(name)
            return original(...args)
          }
        }
        syncBuiltinESMExports()
        ${cancel ? `
          const { startDesktopLogin } = await import('./electron/login/bootstrap.ts')
          const pending = startDesktopLogin()
          app.emit('before-quit', { preventDefault() {} })
          void Promise.all([pending, startDesktopLogin()]).then(results => {
            globalThis.loginProbe.cancelled = results.every(result => result === null)
          })
        ` : `
          await import('./electron/entry.ts')
          const { startDesktopLogin } = await import('./electron/login/bootstrap.ts')
          globalThis.loginProbe.repeat = startDesktopLogin() === startDesktopLogin()
        `}
      `
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['electron'],
    outfile: output
  })
  const env = { ...process.env, HERMES_HOME: home, HERMES_DESKTOP_USER_DATA_DIR: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const instance = await electron.launch({ executablePath: electronPath, args: [output], env, timeout: 30_000 })
  return { instance, root, home, userData, oldConnection }
}

test('真实未登录入口不启动后端、不暴露原版桥接，重复启动只有一个窗口', { timeout: 60_000 }, async () => {
  const fixture = await launchFixture()
  const { instance } = fixture
  try {
    const page = await instance.firstWindow()
    await page.getByRole('status').waitFor()
    assert.match(await page.getByRole('status').textContent(), /本地 Hermes 尚未启动/)
    assert.deepEqual(await page.evaluate(() => ({
      node: typeof globalThis.require,
      bridge: typeof globalThis.hermesDesktop
    })), { node: 'undefined', bridge: 'undefined' })
    const state = await instance.evaluate(({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return {
        probe: globalThis.loginProbe,
        windows: BrowserWindow.getAllWindows().length,
        prefs: window.webContents.getLastWebPreferences(),
        backendIpcListeners: ipcMain.eventNames().filter(name => String(name).startsWith('hermes:'))
      }
    })
    assert.equal(state.windows, 1)
    assert.equal(state.probe.repeat, true)
    assert.deepEqual(state.probe.processCalls, [])
    assert.deepEqual(state.backendIpcListeners, [])
    assert.equal(state.prefs.sandbox, true)
    assert.equal(state.prefs.contextIsolation, true)
    assert.equal(state.prefs.nodeIntegration, false)
    assert.equal(state.prefs.webviewTag, false)
    assert.equal(Boolean(state.prefs.preload), false)
    await assert.rejects(access(fixture.home), { code: 'ENOENT' })
    assert.equal(await readFile(path.join(fixture.userData, 'connection.json'), 'utf8'), fixture.oldConnection)
    const child = instance.process()
    const exited = once(child, 'exit')
    const closed = instance.waitForEvent('close')
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await closed
    assert.equal((await exited)[0], 0)
    console.log(`登录入口真实验收目录：${fixture.root}`)
  } finally {
    await instance.close()
  }
})

test('窗口尚未创建时取消启动，不再打开窗口或启动账号运行时', { timeout: 60_000 }, async () => {
  const { instance, home, root } = await launchFixture(true)
  try {
    const state = await instance.evaluate(async ({ app, BrowserWindow }) => {
      await app.whenReady()
      return { probe: globalThis.loginProbe, windows: BrowserWindow.getAllWindows().length }
    })
    assert.equal(state.probe.cancelled, true)
    assert.equal(state.windows, 0)
    assert.deepEqual(state.probe.processCalls, [])
    await assert.rejects(access(home), { code: 'ENOENT' })
    console.log(`启动取消真实验收目录：${root}`)
  } finally {
    await instance.close()
  }
})
