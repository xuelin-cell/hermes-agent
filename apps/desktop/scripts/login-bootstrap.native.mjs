import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, access, rmdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'
import electronPath from 'electron'
import { _electron as electron } from '@playwright/test'
import { prepareLoginRenderer, startLoginDevServer } from './login-renderer.fixture.mjs'

const desktop = path.resolve(import.meta.dirname, '..')

/** 构建真实入口和只供测试使用的观察层，所有数据写入独立临时目录。 */
async function launchFixture(cancel = false, devServer, liveCaptcha = false) {
  const rendererRoot = await prepareLoginRenderer()
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
        import { app, net } from 'electron'
        import { CredentialStore } from './electron/login/credential-store.ts'
        app.setAppPath(${JSON.stringify(rendererRoot)})
        globalThis.loginProbe = { processCalls: [], captchaRequests: [], cancelled: false }
        // 只向测试主进程提供读取探针，不暴露给 Renderer 或 preload。
        globalThis.readLoginRecord = () => new CredentialStore(app.getPath('userData')).load()
        // 测试过期恢复时，仍用真实系统加密写入完整记录。
        globalThis.saveLoginRecord = identity => new CredentialStore(app.getPath('userData')).save(identity)
        // 回归测试使用固定响应；只有显式启用的真实验收请求 MaaS。
        const originalFetch = net.fetch
        let smsAttempts = 0
        let loginAttempts = 0
        net.fetch = (...args) => {
          globalThis.loginProbe.captchaRequests.push(args[0])
          // 短信始终使用受控响应，测试不能给真实手机发码。
          if (String(args[0]).endsWith('/sendCode')) {
            const code = ++smsAttempts === 1 ? 9 : 0
            return new Promise(resolve => setTimeout(() => resolve(Response.json({code})), 200))
          }
          // 登录也始终使用替身，不消费真实短信码，不获取真实凭据。
          if (String(args[0]).endsWith('/smsLogin')) {
            const result = ++loginAttempts === 1 ? {code:9, msg:'fixture-private-error'} :
              {code:0, data:{uid:'fixture-private-uid', token:'fixture-private-token', expireIn:60}}
            return new Promise(resolve => setTimeout(() => resolve(Response.json(result)), 200))
          }
          return ${liveCaptcha} ? originalFetch(...args) : Promise.resolve(Response.json({code:0, data:{captchaId:'fixture-id', b64s:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII='}}))
        }
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
  delete env.HERMES_DESKTOP_DEV_SERVER
  if (devServer) env.HERMES_DESKTOP_DEV_SERVER = devServer
  delete env.ELECTRON_RUN_AS_NODE
  const instance = await electron.launch({ executablePath: electronPath, args: [output], env, timeout: 30_000 })
  return { instance, root, home, userData, oldConnection, rendererRoot, output, env }
}

test('真实未登录入口不启动后端、不暴露原版桥接，重复启动只有一个窗口', { timeout: 60_000 }, async () => {
  const fixture = await launchFixture()
  const { instance } = fixture
  try {
    const page = await instance.firstWindow()
    await page.getByRole('heading', { name: '登录 Hermes' }).waitFor()
    await page.getByRole('img').waitFor()
    assert.equal(await page.locator('form input').count(), 3)
    assert.equal(await page.locator('button:disabled').count(), 0)
    assert.deepEqual(await page.evaluate(() => ({
      node: typeof globalThis.require,
      bridge: typeof globalThis.hermesDesktop,
      login: Object.keys(globalThis.hermesLogin)
    })), { node: 'undefined', bridge: 'undefined', login: ['restore', 'captcha', 'sendSms', 'login'] })
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

test('开发登录页固定浅色，窄窗无横向溢出，Tab 与 Enter 不绕过字段校验', { timeout: 120_000 }, async () => {
  const { server, url } = await startLoginDevServer()
  let instance
  try {
    const fixture = await launchFixture(false, url)
    instance = fixture.instance
    const page = await instance.firstWindow()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') console.error('[login-renderer]', message.text()) })
    // 独立缓存的 Vite 冷启动约需 27 秒，给并行编译留出有界余量。
    await page.getByRole('heading', { name: '登录 Hermes' }).waitFor({ timeout: 60_000 })
    await page.getByRole('img').waitFor()
    await page.locator('#login-phone').focus()
    await page.keyboard.press('Tab')
    assert.equal(await page.locator('#login-captcha').evaluate(node => node === document.activeElement), true)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    assert.equal(await page.locator('#login-sms').evaluate(node => node === document.activeElement), true)
    await page.keyboard.press('Enter')
    await page.getByText('请输入以 1 开头的 11 位手机号。').waitFor()
    assert.equal((await instance.evaluate(() => globalThis.loginProbe.captchaRequests)).some(url => url.endsWith('/smsLogin')), false)
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(400, 520))
    await page.emulateMedia({ colorScheme: 'dark' })
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.screenshot({ path: path.join(fixture.root, 'login-light.png') })
    const modules = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name))
    assert.equal(modules.some(url => /\/src\/(store\/|themes\/context|main\.tsx)/.test(url)), false)
    assert.deepEqual(errors, [])
    console.log(`登录页浅色窄窗截图：${fixture.root}`)
  } finally {
    await instance?.close()
    await server.close()
  }
})

test('真实 Electron 短信受控链路：错误可重试，成功冷却在刷新页面后仍生效', { timeout: 60_000 }, async () => {
  const { instance, home } = await launchFixture()
  try {
    const page = await instance.firstWindow()
    await page.getByRole('img').waitFor()
    await page.locator('#login-phone').fill('13800000000')
    await page.locator('#login-captcha').fill('abcd')
    await page.getByRole('button', { name: '发送验证码' }).click()
    await page.getByText('发送失败，请检查输入或刷新图片后重试。').waitFor()
    await page.getByRole('img').click()
    await page.getByRole('img').waitFor()
    assert.equal(await page.locator('#login-captcha').inputValue(), '')
    await page.locator('#login-captcha').fill('abcd')
    await page.getByRole('button', { name: '发送验证码' }).click()
    await page.getByText('验证码已发送，请查看手机短信。').waitFor()
    assert.equal(await page.getByRole('button', { name: /秒后重发/ }).isDisabled(), true)
    await page.reload()
    await page.getByRole('img').waitFor()
    const result = await page.evaluate(() => window.hermesLogin.sendSms({phone:'13800000000', captchaCode:'abcd', captchaId:'fixture-id'}))
    assert.equal(result.ok, false)
    assert.equal(result.error, 'limited')
    const probe = await instance.evaluate(() => globalThis.loginProbe)
    assert.equal(probe.captchaRequests.filter(url => url.endsWith('/sendCode')).length, 2)
    assert.deepEqual(probe.processCalls, [])
    await assert.rejects(access(home), { code: 'ENOENT' })
  } finally {
    await instance.close()
  }
})

test('真实 Electron 登录与恢复：有效记录跨进程复用，过期或损坏保留数据并要求登录', { timeout: 60_000 }, async () => {
  const { instance, home, rendererRoot, root, userData, oldConnection, output, env } = await launchFixture()
  const file = path.join(userData, 'maas-login.enc')
  let reopened
  try {
    const page = await instance.firstWindow()
    await page.getByRole('img').waitFor()
    await page.locator('#login-phone').fill('13800000000')
    await page.locator('#login-sms').fill('123456')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByText('登录失败，请重试。').waitFor()
    assert.equal(await page.getByText('fixture-private-error').count(), 0)
    await assert.rejects(access(file), {code:'ENOENT'})
    // 临时文件位置不可写时，真实上游成功响应也不能完成本地登录。
    await mkdir(`${file}.tmp`)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByText('登录失败，请重试。').waitFor()
    assert.equal(await page.locator('form input').count(), 3)
    await assert.rejects(access(file), {code:'ENOENT'})
    await rmdir(`${file}.tmp`)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByText('已登录：138****0000').waitFor()
    assert.equal(await page.locator('form input').count(), 0)
    const visible = await page.evaluate(() => document.body.textContent + JSON.stringify({...localStorage}))
    for (const secret of ['fixture-private-token', 'fixture-private-uid', '13800000000', '123456']) assert.equal(visible.includes(secret), false)
    const result = await page.evaluate(() => window.hermesLogin.login({phone:'13800000000', smsCode:'123456'}))
    assert.equal(result.ok, true)
    assert.deepEqual(Object.keys(result.account), ['maskedPhone', 'expiresAt'])
    const denied = await instance.evaluate(async ({ BrowserWindow }, preload) => {
      const extra = new BrowserWindow({show:false, webPreferences:{preload, sandbox:true, contextIsolation:true, nodeIntegration:false}})
      try {
        await extra.loadURL('about:blank')
        return await extra.webContents.executeJavaScript('(async () => ({restore:await window.hermesLogin.restore(),login:await window.hermesLogin.login({phone:"13800000000",smsCode:"123456"})}))()')
      } finally { extra.destroy() }
    }, path.join(rendererRoot, 'dist', 'login-preload.js'))
    assert.deepEqual(denied, {restore:{ok:false},login:{ok:false}})
    const probe = await instance.evaluate(() => globalThis.loginProbe)
    assert.equal(probe.captchaRequests.filter(url => url.endsWith('/smsLogin')).length, 3)
    assert.deepEqual(probe.processCalls, [])
    await assert.rejects(access(home), {code:'ENOENT'})
    const encrypted = await readFile(file)
    for (const secret of ['fixture-private-token', 'fixture-private-uid', '13800000000', '123456']) {
      assert.equal(encrypted.includes(Buffer.from(secret)), false)
    }
    await assert.rejects(access(`${file}.tmp`), {code:'ENOENT'})
    const record = await instance.evaluate(() => globalThis.readLoginRecord())
    assert.equal(record.namespace, 'maas.ai-yuanjing.com/uniwork')
    assert.equal(record.uid, 'fixture-private-uid')
    assert.equal(record.token, 'fixture-private-token')
    assert.equal(record.maskedPhone, '138****0000')
    assert.equal(record.expiresAt, result.account.expiresAt)
    await page.screenshot({path:path.join(root, 'login-account.png')})
    await instance.close()
    // 同一目录、同一 Windows 用户、新 Electron 进程：使用真实系统密钥解密。
    reopened = await electron.launch({executablePath:electronPath, args:[output], env, timeout:30_000})
    const reopenedPage = await reopened.firstWindow()
    await reopenedPage.getByText('已登录：138****0000').waitFor()
    assert.equal(await reopenedPage.locator('form input').count(), 0)
    assert.deepEqual(await reopenedPage.evaluate(() => window.hermesLogin.restore()), result)
    assert.deepEqual(await reopened.evaluate(() => globalThis.readLoginRecord()), record)
    assert.deepEqual(await reopened.evaluate(() => globalThis.loginProbe.captchaRequests), [])
    assert.deepEqual(await readFile(file), encrypted)
    await reopenedPage.screenshot({path:path.join(root, 'login-restored.png')})
    // 保留原 UID 和 token，仅把记录设为过期；新进程必须显示登录表单。
    await reopened.evaluate((_, saved) => globalThis.saveLoginRecord({...saved, expiresAt:1}), record)
    const expired = await readFile(file)
    await reopened.close()
    reopened = await electron.launch({executablePath:electronPath, args:[output], env, timeout:30_000})
    const expiredPage = await reopened.firstWindow()
    await expiredPage.getByRole('img').waitFor()
    assert.equal(await expiredPage.locator('form input').count(), 3)
    assert.deepEqual(await expiredPage.evaluate(() => window.hermesLogin.restore()), {ok:false})
    assert.deepEqual(await readFile(file), expired)
    // 坏密文和明文冒充记录都要在全新进程中拒绝恢复，不删除原文件。
    for (const invalid of [Buffer.from('damaged-ciphertext'), Buffer.from(JSON.stringify(record))]) {
      await reopened.close()
      await writeFile(file, invalid)
      reopened = await electron.launch({executablePath:electronPath, args:[output], env, timeout:30_000})
      const invalidPage = await reopened.firstWindow()
      await invalidPage.getByRole('img').waitFor()
      assert.equal(await invalidPage.locator('form input').count(), 3)
      assert.deepEqual(await invalidPage.evaluate(() => window.hermesLogin.restore()), {ok:false})
      assert.deepEqual(await readFile(file), invalid)
      assert.equal((await reopened.evaluate(() => globalThis.loginProbe.captchaRequests)).some(url => url.endsWith('/smsLogin')), false)
      assert.deepEqual(await reopened.evaluate(() => globalThis.loginProbe.processCalls), [])
      assert.equal(await readFile(path.join(userData, 'connection.json'), 'utf8'), oldConnection)
    }
    assert.deepEqual(await reopened.evaluate(() => globalThis.loginProbe.processCalls), [])
    await assert.rejects(access(home), {code:'ENOENT'})
    console.log(`登录恢复与跨进程加密验收目录：${root}`)
  } finally {
    await reopened?.close()
    await instance.close()
  }
})

test('真实 MaaS 图片在登录窗口展示并可刷新，其他窗口与子框架无权请求', {
  timeout: 60_000, skip: process.env.HERMES_LOGIN_LIVE_CAPTCHA !== '1'
}, async () => {
  const { instance, root, home, rendererRoot } = await launchFixture(false, undefined, true)
  try {
    const page = await instance.firstWindow()
    const image = page.getByRole('img', { name: '图形验证码' })
    await image.waitFor({ timeout: 20_000 })
    await page.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0)
    await image.click()
    await image.waitFor({ timeout: 20_000 })
    await page.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0)
    const inputBounds = await page.locator('#login-captcha').boundingBox()
    const imageBounds = await image.boundingBox()
    assert.equal(imageBounds.x > inputBounds.x, true)
    assert.equal(Math.abs(imageBounds.y - inputBounds.y) <= 2, true)
    await page.screenshot({ path: path.join(root, 'login-live-captcha.png') })
    const probe = await instance.evaluate(() => globalThis.loginProbe)
    assert.deepEqual(probe.captchaRequests, Array(2).fill('https://maas.ai-yuanjing.com/app/login/captcha'))
    assert.deepEqual(probe.processCalls, [])
    assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.startsWith('https://maas.'))), false)
    const frame = await page.evaluate(async () => {
      const iframe = document.createElement('iframe')
      document.body.append(iframe)
      return typeof iframe.contentWindow.hermesLogin
    })
    assert.equal(frame, 'undefined')
    const unauthorized = await instance.evaluate(async ({ BrowserWindow }, preload) => {
      const other = new BrowserWindow({ show: false, webPreferences: {
        sandbox: true, contextIsolation: true, preload
      } })
      try {
        await other.loadURL('about:blank')
        return await other.webContents.executeJavaScript('window.hermesLogin.captcha()')
      } finally { other.destroy() }
    }, path.join(rendererRoot, 'dist/login-preload.js'))
    assert.deepEqual(unauthorized, { ok: false })
    assert.equal((await instance.evaluate(() => globalThis.loginProbe.captchaRequests.length)), 2)
    await assert.rejects(access(home), { code: 'ENOENT' })
    console.log(`真实 MaaS 验证码验收截图：${root}`)
  } finally { await instance.close() }
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
