import assert from 'node:assert/strict'
import { once } from 'node:events'
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { _electron as electron, expect } from '@playwright/test'
import electronPath from 'electron'
import { build } from 'esbuild'

import { prepareLoginRenderer, startLoginDevServer } from './login-renderer.fixture.mjs'

const desktop = path.resolve(import.meta.dirname, '..')
const legacyKeys = ['auth_token', 'user_info', 'api_token_info', 'auth_application']

// 仅在测试 HTML 中观察真实 Chromium 存储，先于主页面任何模块执行。
const storageProbe = `
  window.legacyLoginOperations = [];
  for (const operation of ['getItem', 'removeItem']) {
    const original = Storage.prototype[operation];
    Storage.prototype[operation] = function(...args) {
      if (${JSON.stringify(legacyKeys)}.includes(args[0])) window.legacyLoginOperations.push([operation, args[0]]);
      return original.apply(this, args);
    };
  }
`

/** 构建正式入口和 preload；只控制 MaaS 响应及系统对话框，不替换账号、后端或退出逻辑。 */
async function prepareFixture(url) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-single-login-'))
  const renderer = await prepareLoginRenderer()
  const userData = path.join(root, 'user-data')
  await mkdir(userData)
  const cache = path.join(desktop, 'node_modules', '.cache')
  await mkdir(cache, { recursive: true })
  const output = path.join(await mkdtemp(path.join(cache, 'single-login-')), 'main.mjs')
  await build({ entryPoints: [path.join(desktop, 'electron/preload.ts')], bundle: true, platform: 'node',
    format: 'cjs', external: ['electron'], outfile: path.join(renderer, 'dist/electron-preload.js') })
  await build({ stdin: { resolveDir: desktop, contents: `
    import {app, dialog, net} from 'electron'
    import {writeFileSync} from 'node:fs'
    import {CredentialStore} from './electron/login/credential-store'
    app.setAppPath(${JSON.stringify(renderer)})
    app.disableHardwareAcceleration()
    app.setAsDefaultProtocolClient = () => false
    // 夹具自行重开进程；保留正式重启请求，避免 Electron 另行派生无人持有的测试实例。
    app.relaunch = () => writeFileSync(${JSON.stringify(path.join(root, 'relaunch-requested'))}, 'requested')
    globalThis.fixtureRequests = []
    globalThis.fixtureErrors = []
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1)
      globalThis.fixtureErrors.push(options.message)
      return {response:options.buttons?.includes('退出应用') ? options.buttons.indexOf('退出应用') : 1, checkboxChecked:false}
    }
    app.on('web-contents-created', (_event, contents) => {
      contents.session.webRequest.onBeforeRequest((request, done) => {
        globalThis.fixtureRequests.push(request.url)
        const url = new URL(request.url)
        done({cancel:!['127.0.0.1', 'localhost', ''].includes(url.hostname)})
      })
    })
    const originalFetch = net.fetch
    net.fetch = (...args) => {
      const url = String(args[0])
      globalThis.fixtureRequests.push(url)
      if (!url.startsWith('https://maas.ai-yuanjing.com/')) return originalFetch(...args)
      if (url.endsWith('/smsLogin')) return Promise.resolve(Response.json({code:0, data:{
        uid:process.env.FIXTURE_UID, token:'controlled-maas-token', expireIn:1800}}))
      if (url.endsWith('/my-plan')) return Promise.resolve(Response.json({apiKey:'controlled-model-key',
        models:{models:[{id:'fixture', model:'fixture-desktop-model', base_url:'https://models.invalid/v1'}]}}))
      if (url.endsWith('/captcha')) return Promise.resolve(Response.json({code:0, data:{captchaId:'fixture',
        b64s:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII='}}))
      if (url.endsWith('/sendCode')) return Promise.resolve(Response.json({code:0}))
      throw new Error('Unexpected MaaS request')
    }
    await import('./electron/entry')
    const {currentDesktopLocalContext} = await import('./electron/login/bootstrap')
    globalThis.fixtureContext = () => currentDesktopLocalContext()
    globalThis.fixtureIdentity = () => new CredentialStore(app.getPath('userData')).load()
  ` }, bundle: true, format: 'esm', platform: 'node', external: ['electron', 'node-pty', 'get-windows'], outfile: output,
    define: { __HERMES_PRODUCT_IDENTITY__: JSON.stringify(createRequire(import.meta.url)(path.join(desktop, 'product-identity.cjs'))) },
    banner: { js: `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(path.join(desktop, 'dist/electron-main.mjs'))});` } })
  const env = { ...process.env, LOCALAPPDATA: path.join(root, 'local-app-data'), HERMES_HOME: path.join(root, 'unused-home'),
    HERMES_DESKTOP_USER_DATA_DIR: userData, HERMES_DESKTOP_HERMES_ROOT: path.resolve(desktop, '../..'),
    HERMES_DESKTOP_DEV_SERVER: url, HERMES_DESKTOP_CDP_PORT: 'off', HERMES_SKIP_INTRO: '1',
    HERMES_GUEST_ONBOARDING: '0', HERMES_DESKTOP_SKIP_QUIT_CONFIRM: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.HERMES_DESKTOP_PYTHON
  if (process.env.FIXTURE_PYTHON) env.HERMES_DESKTOP_PYTHON = process.env.FIXTURE_PYTHON
  return { root, output, userData, env }
}

/** 只操作本测试启动的登录窗口，执行真实表单、受限 IPC 和系统加密。 */
async function signIn(instance, phone) {
  const page = await instance.firstWindow()
  await page.locator('#login-phone').waitFor({ timeout: 120_000 })
  assert.equal(await instance.evaluate(() => globalThis.fixtureContext()), null)
  await page.locator('#login-phone').fill(phone)
  await page.locator('#login-sms').fill('123456')
  await page.locator('button[type="submit"]').click()
}

/** 以实际聊天输入区、后端 REST 和 WS 为就绪证据，不以窗口出现代替可用。 */
async function readyDesktop(instance) {
  await expect.poll(() => instance.windows().some(page => page.url().startsWith('http') && !page.url().includes('login.html')),
    { timeout: 120_000 }).toBe(true)
  const page = instance.windows().find(page => page.url().startsWith('http') && !page.url().includes('login.html'))
  await page.locator('[data-slot=statusbar]').waitFor({ timeout: 120_000 })
  // 恢复可能停在上次访问的云盘页；明确返回聊天，再验收输入区和草稿。
  await page.evaluate(() => { location.hash = '/' })
  await page.locator('textarea,[contenteditable="true"]').first().waitFor({ timeout: 120_000 })
  assert.equal(await page.locator('#login-phone').count(), 0)
  assert.equal(instance.windows().some(page => page.url().includes('login.html')), false)
  assert.deepEqual(await page.evaluate(() => window.legacyLoginOperations), [])
  const connection = await page.evaluate(() => window.hermesDesktop.getConnection())
  assert.equal(new URL(connection.baseUrl).hostname, '127.0.0.1')
  assert.notEqual(connection.token, 'controlled-maas-token')
  assert.ok(await page.evaluate(() => window.hermesDesktop.api({ method: 'GET', path: '/api/status' })))
  assert.equal((await fetch(`${connection.baseUrl}/api/profiles`)).status, 401)
  assert.equal((await fetch(`${connection.baseUrl}/api/profiles`, { headers: { Authorization: `Bearer ${connection.token}` } })).status, 200)
  const ws = await page.evaluate(async () => {
    const route = await window.hermesDesktop.getGatewayWsUrl()
    if (!route.ok) return false
    return new Promise(resolve => {
      const socket = new WebSocket(route.wsUrl)
      const timer = setTimeout(() => { socket.close(); resolve(false) }, 15_000)
      socket.onmessage = () => { clearTimeout(timer); socket.close(); resolve(true) }
      socket.onerror = () => { clearTimeout(timer); socket.close(); resolve(false) }
    })
  })
  assert.equal(ws, true)
  assert.equal((await instance.evaluate(() => globalThis.fixtureRequests)).some(url => url.includes('/api/uniwork/')), false)
  return page
}

/** 使用正式退出账号 IPC 和停止事务，确认凭据已清除后才启动下一账号。 */
async function signOut(instance, page, fixture) {
  const exited = once(instance.process(), 'exit', { signal: AbortSignal.timeout(45_000) })
  await page.locator('[data-slot=statusbar]').getByRole('button', { name: '退出', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '退出', exact: true }).click()
  // 页面执行真实确认；重启动作由夹具接管，停止与凭据清除仍由正式实现产生。
  const [code] = await exited
  assert.equal(code, 0)
  assert.equal(await readFile(path.join(fixture.root, 'relaunch-requested'), 'utf8'), 'requested')
  await assert.rejects(access(path.join(fixture.userData, 'maas-login.enc')), { code: 'ENOENT' })
}

/** 兼顾正式桌面的可编辑元素和 textarea，比较完整草稿正文，不只检查存储文件存在。 */
function composerText(editor) {
  return editor.evaluate(element => element.value ?? element.textContent)
}

test('R08 原生单登录：首次／恢复／退出重登、A→B→A、旧 Web 身份不拦截或污染桌面', { timeout: 600_000 }, async () => {
  const { server, url } = await startLoginDevServer({ plugins: [{ name: 'observe-legacy-storage', transformIndexHtml: {
    order: 'pre', handler: (_html, context) => context.filename.endsWith('index.html')
      ? [{ tag: 'script', children: storageProbe, injectTo: 'head-prepend' }] : []
  } }] })
  let instance
  try {
    const fixture = await prepareFixture(url)
    console.log(`R08 隔离验收目录：${fixture.root}`)
    let firstA
    let encryptedA
    for (const [index, uid] of ['fixture-r08-A', 'fixture-r08-A', 'fixture-r08-B', 'fixture-r08-A'].entries()) {
      console.log(`R08 场景 ${index}：${uid}，${index === 1 ? '恢复' : '表单登录'}`)
      instance = await electron.launch({ executablePath: electronPath, args: [fixture.output],
        env: { ...fixture.env, FIXTURE_UID: uid }, timeout: 45_000 })
      if (index !== 1) await signIn(instance, uid.endsWith('A') ? '13800000000' : '13900000000')
      const page = await readyDesktop(instance)
      const context = await instance.evaluate(() => globalThis.fixtureContext())
      const identity = await instance.evaluate(() => globalThis.fixtureIdentity())
      assert.equal(identity.uid, uid)
      assert.equal(await page.evaluate(() => typeof window.hermesLogin), 'undefined')
      const saved = await readFile(path.join(fixture.userData, 'maas-login.enc'))
      if (index === 0) { firstA = context; encryptedA = saved }
      if (index === 1) assert.deepEqual(saved, encryptedA)
      if (uid.endsWith('A')) assert.deepEqual(context, firstA)
      else { assert.notEqual(context.id, firstA.id); assert.notEqual(context.home, firstA.home) }
      const marker = path.join(context.workspace, 'account-file.txt')
      if (index === 0) await writeFile(marker, 'account-A-file')
      else if (uid.endsWith('A')) assert.equal(await readFile(marker, 'utf8'), 'account-A-file')
      else await assert.rejects(access(marker), { code: 'ENOENT' })
      assert.equal((await page.evaluate(() => window.hermesDesktop.getMaasAccount())).maskedPhone,
        uid.endsWith('A') ? '138****0000' : '139****0000')
      if (index !== 1) {
        const legacy = await page.evaluate(({ keys, index }) => {
          localStorage.setItem(keys[0], 'conflicting-web-token')
          localStorage.setItem(keys[1], JSON.stringify({ uid: 'other-web-account', expiresAt: index === 0 ? '2020-01-01' : '2099-01-01' }))
          localStorage.setItem(keys[2], index === 0 ? 'invalid-old-json' : JSON.stringify({ expires_in: 3600, successDate: Date.now() }))
          localStorage.setItem(keys[3], 'uniwork')
          return keys.map(key => localStorage.getItem(key))
        }, { keys: legacyKeys, index })
        await page.reload()
        await readyDesktop(instance)
        assert.deepEqual(await page.evaluate(keys => keys.map(key => localStorage.getItem(key)), legacyKeys), legacy)
        assert.equal((await instance.evaluate(() => globalThis.fixtureIdentity())).uid, uid)
      }
      const editor = page.locator('textarea,[contenteditable="true"]').first()
      if (index === 0) {
        await editor.fill('fixture-unsent-A')
        await page.waitForFunction(() => localStorage.getItem('hermes:composer-drafts:v3')?.includes('fixture-unsent-A'), null, { polling: 100 })
      } else if (uid.endsWith('A')) await expect.poll(() => composerText(editor), { timeout: 30_000 }).toBe('fixture-unsent-A')
      else assert.equal(await composerText(editor), '')
      await page.evaluate(() => { location.hash = '/artifacts' })
      await page.getByText('云盘接口待接入', { exact: true }).waitFor()
      assert.equal((await instance.evaluate(() => globalThis.fixtureRequests)).some(request => request.includes('/api/uniwork/')), false)
      await page.screenshot({ path: path.join(fixture.root, `account-${index}.png`) })
      // 用户明确回到聊天；等待正式导航持久化，避免下次冷启动正确恢复云盘页时误查草稿。
      await page.evaluate(() => { location.hash = '/' })
      await page.waitForFunction(() => localStorage.getItem('hermes.desktop.lastRoute.profile.default') === '/', null, { polling: 100 })
      await editor.waitFor()
      if (uid.endsWith('A')) await expect.poll(() => composerText(editor), { timeout: 30_000 }).toBe('fixture-unsent-A')
      if (index === 0 || index === 3) { await instance.close(); instance = null }
      else { await signOut(instance, page, fixture); instance = null }
    }
  } finally {
    await instance?.close()
    await server.close()
  }
})
