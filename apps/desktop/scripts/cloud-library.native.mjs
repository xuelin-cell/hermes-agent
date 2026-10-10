import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { _electron as electron, expect } from '@playwright/test'
import { build as bundle } from 'esbuild'
import electronPath from 'electron'
import { createServer } from 'vite'

const desktop = path.resolve(import.meta.dirname, '..')
const legacyKeys = ['auth_token', 'user_info', 'api_token_info', 'auth_application']

/** 加载正式产物页与 preload，用受控本地响应验证展示和 IPC，避免启动用户后端。 */
async function prepareFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-cloud-library-'))
  const entry = path.join(root, 'fixture.jsx')
  // 将正式模块的绝对路径转为夹具中的安全 JavaScript 字符串。
  const sourcePath = relative => JSON.stringify(path.join(desktop, relative).replaceAll('\\', '/'))
  await writeFile(entry, `
    import ${sourcePath('src/styles.css')}
    import { createRoot } from 'react-dom/client'
    import { MemoryRouter } from 'react-router'
    import { I18nProvider } from ${sourcePath('src/i18n/context.tsx')}
    import { ArtifactsView } from ${sourcePath('src/app/artifacts/index.tsx')}
    createRoot(document.getElementById('root')).render(
      <I18nProvider configClient={null} initialLocale="zh"><MemoryRouter><ArtifactsView /></MemoryRouter></I18nProvider>
    )
  `)
  const html = `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/@fs/${entry.replaceAll('\\', '/')}"></script></body></html>`
  const server = await createServer({
    root: desktop,
    cacheDir: path.join(root, 'vite-cache'),
    logLevel: 'warn',
    server: { host: '127.0.0.1', port: 0, open: false, fs: { allow: [path.dirname(desktop), path.resolve(desktop, '../..'), root] } },
    plugins: [{
      name: 'cloud-library-fixture',
      /** 仅为独立测试入口提供 HTML，源码和样式由正式 Vite 配置处理。 */
      configureServer(vite) {
        vite.middlewares.use('/fixture.html', async (_request, response, next) => {
          try {
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            response.end(await vite.transformIndexHtml('/fixture.html', html))
          } catch (error) { next(error) }
        })
      }
    }]
  })
  await server.listen()
  try {
    await bundle({ entryPoints: [path.join(desktop, 'electron/preload.ts')], bundle: true,
      platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(root, 'preload.cjs') })
    await writeFile(path.join(root, 'main.cjs'), `
      const { app, BrowserWindow, ipcMain, session } = require('electron')
      // 独立 UI 夹具沿用 E2E 的软件渲染，避免依赖用户桌面的 GPU 状态。
      app.disableHardwareAcceleration()
      app.setPath('userData', ${JSON.stringify(path.join(root, 'user-data'))})
      globalThis.driveProbe = {requests: [], external: [], network: []}
      for (const channel of ['hermes:translucency:support', 'hermes:hud:windowing', 'hermes:feature-flags', 'hermes:skin:local']) {
        ipcMain.on(channel, event => { event.returnValue = {} })
      }
      ipcMain.handle('hermes:api', (_event, request) => {
        globalThis.driveProbe.requests.push(request)
        if (request.path.startsWith('/api/profiles/sessions?')) return {
          sessions: [{id:'local-session', title:'Fixture', profile:'default', started_at:1000}], total:1
        }
        if (request.path.startsWith('/api/sessions/local-session/messages')) return {
          session_id:'local-session', messages:[{role:'assistant', timestamp:1000, content:'MEDIA:/tmp/local-report.txt'}]
        }
        throw new Error('Unexpected fixture API: ' + request.path)
      })
      ipcMain.handle('hermes:openExternal', (_event, url) => { globalThis.driveProbe.external.push(url) })
      app.whenReady().then(() => {
        session.defaultSession.webRequest.onBeforeRequest({urls:['https://*/*']}, (details, done) => {
          globalThis.driveProbe.network.push(details.url)
          done({cancel:true})
        })
        const window = new BrowserWindow({width:1080, height:760, webPreferences:{
          preload:${JSON.stringify(path.join(root, 'preload.cjs'))}, contextIsolation:true, sandbox:true, nodeIntegration:false, backgroundThrottling:false
        }})
        window.loadURL('about:blank')
      })
      app.on('window-all-closed', () => app.quit())
    `)
    return {root, server, url:`http://127.0.0.1:${server.httpServer.address().port}/fixture.html`}
  } catch (error) {
    await server.close()
    throw error
  }
}

test('隔离 Electron 云盘无请求及旧凭据读取，窄窗可见，本地产物仍走正式 IPC', {timeout:120_000}, async () => {
  const fixture = await prepareFixture()
  let instance
  try {
    const env = {...process.env, HERMES_HOME:path.join(fixture.root, 'hermes-home'), LOCALAPPDATA:fixture.root}
    delete env.ELECTRON_RUN_AS_NODE
    instance = await electron.launch({executablePath:electronPath, args:[path.join(fixture.root, 'main.cjs')], cwd:desktop, env})
    console.log('云盘夹具主进程已就绪')
    const page = await instance.firstWindow()
    console.log('云盘夹具窗口已就绪')
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      localStorage.setItem('auth_application', 'uniwork')
      localStorage.setItem('auth_token', 'legacy-fixture-token')
      localStorage.setItem('user_info', JSON.stringify({phone:'13800000000', token:'legacy-fixture-token'}))
      globalThis.driveStorageReads = []
      // 记录真实页面的存储读取；种下旧登录并不参与当前页面鉴权。
      const original = Storage.prototype.getItem
      Storage.prototype.getItem = function(key) {
        globalThis.driveStorageReads.push(key)
        return original.call(this, key)
      }
    })
    await page.goto(fixture.url)
    console.log('云盘夹具页面已导航')
    await page.getByText('云盘接口待接入', {exact:true}).waitFor({timeout:60_000})
    await expect(page.getByRole('button', {name:'个人云盘', exact:true})).toBeVisible()
    await expect(page.getByRole('button', {name:'本地产物', exact:true})).toBeEnabled()
    await expect(page.getByRole('textbox', {name:'搜索当前文件夹'})).toBeDisabled()
    for (const name of ['新建文件夹', '刷新', '重命名', '移入回收站', '预览', '下载']) {
      const button = page.getByRole('button', {name, exact:true})
      await expect(button).toBeDisabled()
      await button.dispatchEvent('click')
    }
    assert.deepEqual((await instance.evaluate(() => globalThis.driveProbe)).requests, [])
    assert.deepEqual((await page.evaluate(() => globalThis.driveStorageReads)).filter(key => legacyKeys.includes(key)), [])
    await page.screenshot({path:path.join(fixture.root, 'cloud-wide.png')})
    await instance.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(400, 520))
    await expect(page.getByText('云盘接口待接入', {exact:true})).toBeVisible()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    for (const control of await page.locator('input, button').all()) {
      const bounds = await control.boundingBox()
      const width = await page.evaluate(() => innerWidth)
      assert.equal(bounds.x >= 0 && bounds.x + bounds.width <= width, true, JSON.stringify({bounds, width}))
    }
    await page.screenshot({path:path.join(fixture.root, 'cloud-narrow.png')})
    await page.getByRole('button', {name:'本地产物', exact:true}).click()
    const file = page.getByRole('button', {name:'local-report.txt', exact:true})
    await file.waitFor()
    await file.click()
    await expect.poll(() => instance.evaluate(() => globalThis.driveProbe.external.length)).toBe(1)
    await page.getByRole('button', {name:'个人云盘', exact:true}).click()
    await expect(page.getByText('云盘接口待接入', {exact:true})).toBeVisible()
    const probe = await instance.evaluate(() => globalThis.driveProbe)
    assert.equal(probe.requests.some(request => request.path.includes('/uniwork/')), false)
    assert.equal(probe.requests.some(request => request.path.startsWith('/api/profiles/sessions?')), true)
    assert.equal(probe.requests.some(request => request.path.startsWith('/api/sessions/local-session/messages')), true)
    assert.deepEqual(probe.external, ['file:///tmp/local-report.txt'])
    assert.deepEqual(probe.network, [])
    assert.deepEqual((await page.evaluate(() => globalThis.driveStorageReads)).filter(key => legacyKeys.includes(key)), [])
    assert.deepEqual(errors, [])
    console.log('云盘独立窗口与截图：' + fixture.root)
  } catch (error) {
    console.error(error)
    throw error
  } finally {
    await instance?.close()
    await fixture.server.close()
  }
})
