import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, access, rmdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { parseEnv } from 'node:util'
import { build } from 'esbuild'
import electronPath from 'electron'
import { _electron as electron, expect } from '@playwright/test'
import { parse, stringify } from 'yaml'
import { prepareLoginRenderer, startLoginDevServer } from './login-renderer.fixture.mjs'

const desktop = path.resolve(import.meta.dirname, '..')

/** 构建真实入口和只供测试使用的观察层，所有数据写入独立临时目录。 */
async function launchFixture(cancel = false, devServer, liveCaptcha = false, planScenario = false) {
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
        import { app, dialog, net } from 'electron'
        import { CredentialStore } from './electron/login/credential-store.ts'
        import { LoginSession } from './electron/login/session.ts'
        import { prepareLocalAccount, prepareLocalEnvironment } from './electron/entry_local/prepare-account.ts'
        import { createSourcePythonBackend } from './electron/source-backend.ts'
        app.setAppPath(${JSON.stringify(rendererRoot)})
        globalThis.loginProbe = { processCalls: [], captchaRequests: [], planAuthorizations: [], cancelled: false }
        // 观察原版 Chromium 设置的真实时序，不替代 Electron 的执行。
        globalThis.loginProbe.launchCalls = []
        const originalSwitch = app.commandLine.appendSwitch.bind(app.commandLine)
        app.commandLine.appendSwitch = (...args) => {
          globalThis.loginProbe.launchCalls.push({args, ready:app.isReady()})
          return originalSwitch(...args)
        }
        // 用事件确认请求已经进入主进程，避免用固定等待猜测异步顺序。
        globalThis.waitForFixturePlan = () => new Promise(resolve => { globalThis.nextFixturePlan = resolve })
        // 测试只观察受控错误，避免模态框阻塞隔离应用；正式入口仍显示错误提示。
        dialog.showMessageBox = async (_window, options) => {
          options ??= _window
          globalThis.loginProbe.environmentError = options.message
          if (globalThis.loginProbe.holdEnvironmentError) {
            return new Promise(resolve => { globalThis.loginProbe.environmentAnswer = resolve })
          }
          return {response:0, checkboxChecked:false}
        }
        // 只向测试主进程提供读取探针，不暴露给 Renderer 或 preload。
        globalThis.readLoginRecord = () => new CredentialStore(app.getPath('userData')).load()
        // 测试过期恢复时，仍用真实系统加密写入完整记录。
        globalThis.saveLoginRecord = identity => new CredentialStore(app.getPath('userData')).save(identity)
        // P11 组件验收：身份只在主进程解密恢复，目录不经过页面或 IPC 参数。
        globalThis.prepareFixtureAccount = () => {
          const session = new LoginSession(net.fetch, new CredentialStore(app.getPath('userData')))
          try {
            session.restore()
            return prepareLocalAccount(session, {data:${JSON.stringify(path.join(root, 'account-data'))}, userData:app.getPath('userData')})
          } finally { session.dispose() }
        }
        // P12/P13 组件验收：主进程恢复并查询套餐，准备真实账号文件，不经过 Renderer。
        globalThis.prepareFixtureEnvironment = async () => {
          const session = new LoginSession(net.fetch, new CredentialStore(app.getPath('userData')))
          try {
            session.restore()
            const result = await session.queryPlan()
            const account = prepareLocalEnvironment(session, {data:${JSON.stringify(path.join(root, 'account-data'))}, userData:app.getPath('userData')})
            return {account, status:result.status}
          } finally { session.dispose() }
        }
        // 回归测试使用固定响应；只有显式启用的真实验收请求 MaaS。
        const originalFetch = net.fetch
        let smsAttempts = 0
        let loginAttempts = 0
        let planAttempts = 0
        net.fetch = (...args) => {
          globalThis.loginProbe.captchaRequests.push(args[0])
          // 套餐只用当前测试账号；失败、有套餐和空套餐均不调用真实上游。
          if (String(args[0]).endsWith('/my-plan')) {
            globalThis.loginProbe.planAuthorizations.push(args[1]?.headers?.Authorization)
            globalThis.nextFixturePlan?.()
            globalThis.nextFixturePlan = null
            const attempt = ++planAttempts
            const response = globalThis.loginProbe.planMode === 'failed' || (${planScenario} && attempt === 1) ? new Response('fixture-private-plan-error', {status:503}) :
              globalThis.loginProbe.planMode === 'empty' || (${planScenario} && attempt >= 3) ? Response.json({apiKey:null, models:null}) :
              Response.json({apiKey:globalThis.loginProbe.planKey ?? 'fixture-private-model-key', models:JSON.stringify({main_model_id:'b', models:[
                {id:'a', model:'fixture-plan-model', base_url:'https://models.invalid/TokenPlan/a'},
                {id:'b', model:'fixture-plan-default', base_url:'https://models.invalid/TokenPlan/b/v1'}
              ]})})
            return new Promise(resolve => setTimeout(() => {
              globalThis.loginProbe.planCompleted = attempt
              resolve(response)
            }, 200))
          }
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
          app.emit('will-quit', { preventDefault() {} })
          void Promise.all([pending, startDesktopLogin()]).then(results => {
            globalThis.loginProbe.cancelled = results.every(result => result === null)
          })
        ` : `
          await import('./electron/entry.ts')
          const { startDesktopLogin } = await import('./electron/login/bootstrap.ts')
          globalThis.loginProbe.repeat = startDesktopLogin() === startDesktopLogin()
        `}
        const { currentDesktopLocalContext } = await import('./electron/login/bootstrap.ts')
        // P14 观察真实入口的固定上下文，不向页面提供账号路径或启动能力。
        globalThis.currentFixtureRuntime = () => {
          const context = currentDesktopLocalContext()
          if (!context) return null
          const backend = createSourcePythonBackend(context.installationRoot, context.python, ['serve'], {env:{HERMES_HOME:context.home}})
          return {context, frozen:Object.isFrozen(context), source:backend.root, python:backend.command, pythonPath:backend.env.PYTHONPATH, parentHome:process.env.HERMES_HOME}
        }
      `
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['electron'],
    // 此组验证登录组件和准备链，原版桌面交接另由 P15 全入口夹具验证。
    plugins: [{name:'observe-login-handoff', setup(builder) {
      builder.onLoad({filter:/entry_local[\\/]desktop-runtime\.ts$/}, () => ({loader:'ts', contents:`
        /** 此组只观察主进程交接请求，完整原版桌面另有真实夹具。 */
        export async function startAccountDesktop(context) {
          globalThis.loginProbe.handoffs = (globalThis.loginProbe.handoffs ?? 0) + 1
          return new Promise(() => {})
        }
      `}))
    }}],
    // 与正式主进程打包一致，供 yaml 的 Node 内置模块引用使用。
    banner: {js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},
    outfile: output
  })
  const env = {
    ...process.env,
    HERMES_HOME: home,
    HERMES_DESKTOP_USER_DATA_DIR: userData,
    // 独立夹具不争抢用户开发窗口的调试端口。
    HERMES_DESKTOP_CDP_PORT: 'off',
    // 账号默认根与开发安装均明确定位；测试绝不写真实 LOCALAPPDATA。
    LOCALAPPDATA: path.join(root, 'local-app-data'),
    HERMES_DESKTOP_HERMES_ROOT: path.resolve(desktop, '../..')
  }
  delete env.HERMES_DESKTOP_DEV_SERVER
  delete env.HERMES_DESKTOP_PYTHON
  if (devServer) env.HERMES_DESKTOP_DEV_SERVER = devServer
  delete env.ELECTRON_RUN_AS_NODE
  const instance = await electron.launch({ executablePath: electronPath, args: [output], env, timeout: 30_000 })
  return { instance, root, home, userData, oldConnection, rendererRoot, output, env }
}

/** 等待主进程完成交接准备，不再依赖已删除的套餐展示内容。 */
async function waitForLoginHandoff(instance, page) {
  await page.getByRole('status', {name:'CONNECTING', exact:true}).waitFor()
  assert.equal(await page.locator('.desktop-login').count(), 0)
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light')
  await expect.poll(() => instance.evaluate(() => globalThis.loginProbe.handoffs ?? 0)).toBe(1)
}

test('真实未登录入口不启动后端、不暴露原版桥接，重复启动只有一个窗口', { timeout: 60_000 }, async () => {
  const fixture = await launchFixture()
  const { instance } = fixture
  try {
    const page = await instance.firstWindow()
    await page.getByRole('heading', { name: '登录你的工作空间' }).waitFor()
    await page.getByRole('img').waitFor()
    assert.equal(await page.locator('form input').count(), 3)
    assert.equal(await page.locator('button:disabled').count(), 0)
    assert.deepEqual(await page.evaluate(() => ({
      node: typeof globalThis.require,
      bridge: typeof globalThis.hermesDesktop,
      login: Object.keys(globalThis.hermesLogin)
    })), { node: 'undefined', bridge: 'undefined', login: ['restore', 'plan', 'captcha', 'sendSms', 'login'] })
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
    assert.equal(state.probe.launchCalls.some(call => call.args[0] === 'disable-renderer-backgrounding'), true)
    assert.equal(state.probe.launchCalls.every(call => call.ready === false), true)
    if (process.platform === 'win32') {
      const sandboxMarker = JSON.parse(await readFile(path.join(fixture.userData, 'windows-sandbox-fallback.json'), 'utf8'))
      assert.equal(sandboxMarker.state, 'ok')
    }
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

test('开发登录页深色双栏与窄窗可用，Tab 与 Enter 不绕过字段校验', { timeout: 120_000 }, async () => {
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
    await page.getByRole('heading', { name: '登录你的工作空间' }).waitFor({ timeout: 60_000 })
    await page.getByRole('img').waitFor()
    await expect(page.getByRole('complementary')).toBeVisible()
    await page.emulateMedia({ colorScheme: 'light' })
    assert.equal(await page.locator('main').evaluate(node => getComputedStyle(node).colorScheme), 'dark')
    assert.equal(await page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth), true)
    await page.screenshot({ path: path.join(fixture.root, 'login-wide.png') })
    await page.locator('#login-phone').focus()
    await page.keyboard.press('Tab')
    assert.equal(await page.locator('#login-captcha').evaluate(node => node === document.activeElement), true)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    assert.equal(await page.locator('#login-sms').evaluate(node => node === document.activeElement), true)
    await page.keyboard.press('Enter')
    await page.getByText('请输入以 1 开头的 11 位手机号。').waitFor()
    assert.equal((await instance.evaluate(() => globalThis.loginProbe.captchaRequests)).some(url => url.endsWith('/smsLogin')), false)
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(400, 760))
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.getByRole('complementary')).toBeHidden()
    assert.equal(await page.locator('main').evaluate(node => getComputedStyle(node).colorScheme), 'dark')
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    assert.equal(await page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth), true)
    await page.screenshot({ path: path.join(fixture.root, 'login-narrow.png') })
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(400, 300))
    for (const control of await page.locator('form input, form button').all()) {
      // 居中滚动后检查完整边界，避免 Windows 缩放下贴边滚动的亚像素舍入。
      await control.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }))
      const bounds = await control.boundingBox()
      const viewport = await page.evaluate(() => ({width:innerWidth, height:innerHeight}))
      assert.equal(bounds.x >= 0 && bounds.y >= 0, true)
      assert.equal(bounds.x + bounds.width <= viewport.width, true, JSON.stringify({bounds, viewport}))
      assert.equal(bounds.y + bounds.height <= viewport.height, true, JSON.stringify({bounds, viewport}))
    }
    const modules = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name))
    assert.equal(modules.some(url => /\/src\/(store\/|themes\/context|main\.tsx)/.test(url)), false)
    assert.deepEqual(errors, [])
    console.log(`登录页深色双栏与窄窗截图：${fixture.root}`)
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
    await waitForLoginHandoff(instance, page)
    assert.equal(await instance.evaluate(() => globalThis.loginProbe.handoffs), 1)
    assert.equal(await page.locator('form input').count(), 0)
    const visible = await page.evaluate(() => document.body.textContent + JSON.stringify({...localStorage}))
    for (const secret of ['fixture-private-token', 'fixture-private-model-key', 'fixture-private-uid', '13800000000', '123456']) assert.equal(visible.includes(secret), false)
    const result = await page.evaluate(() => window.hermesLogin.login({phone:'13800000000', smsCode:'123456'}))
    assert.equal(result.ok, true)
    assert.deepEqual(Object.keys(result.account), ['maskedPhone', 'expiresAt'])
    const denied = await instance.evaluate(async ({ BrowserWindow }, preload) => {
      const extra = new BrowserWindow({show:false, webPreferences:{preload, sandbox:true, contextIsolation:true, nodeIntegration:false}})
      try {
        await extra.loadURL('about:blank')
        return await extra.webContents.executeJavaScript('(async () => ({restore:await window.hermesLogin.restore(),plan:await window.hermesLogin.plan(),login:await window.hermesLogin.login({phone:"13800000000",smsCode:"123456"})}))()')
      } finally { extra.destroy() }
    }, path.join(rendererRoot, 'dist', 'login-preload.js'))
    assert.deepEqual(denied, {restore:{ok:false},plan:{status:'failed'},login:{ok:false}})
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
    await waitForLoginHandoff(reopened, reopenedPage)
    assert.equal(await reopenedPage.locator('form input').count(), 0)
    assert.deepEqual(await reopenedPage.evaluate(() => window.hermesLogin.restore()), result)
    assert.deepEqual(await reopened.evaluate(() => globalThis.readLoginRecord()), record)
    // 身份恢复本身不联网；P10 在恢复成功后独立查询一次套餐。
    assert.deepEqual(await reopened.evaluate(() => globalThis.loginProbe.captchaRequests), ['https://maas.ai-yuanjing.com/app/gateway/uniwork/my-plan'])
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

test('P11 真实 Electron 组件：加密身份跨进程准备 A→B→A 目录，凭据更新不换目录', {timeout:120_000}, async () => {
  const fixture = await launchFixture()
  let instance = fixture.instance
  let originalA
  try {
    await (await instance.firstWindow()).getByRole('img').waitFor()
    await assert.rejects(instance.evaluate(() => globalThis.prepareFixtureAccount()), /请先登录/)
    await assert.rejects(access(path.join(fixture.root, 'account-data')), {code:'ENOENT'})
    for (const uid of ['fixture-account-A', 'fixture-account-B', 'fixture-account-A']) {
      const identity = {uid, token:`fixture-refreshed-token-${Date.now()}`, maskedPhone:'138****0000', expiresAt:Date.now()+240_000}
      await instance.evaluate((_, saved) => globalThis.saveLoginRecord(saved), identity)
      await instance.close()
      instance = await electron.launch({executablePath:electronPath, args:[fixture.output], env:fixture.env, timeout:30_000})
      const page = await instance.firstWindow()
      await waitForLoginHandoff(instance, page)
      const account = await instance.evaluate(() => globalThis.prepareFixtureAccount())
      assert.deepEqual(await instance.evaluate(() => globalThis.prepareFixtureAccount()), account)
      assert.match(account.id, /^account-[a-f0-9]{64}$/)
      for (const directory of [account.home, account.workspace, account.desktopState]) {
        const marker = path.join(directory, 'account-marker')
        if (uid.endsWith('-A') && originalA) assert.equal(await readFile(marker, 'utf8'), 'fixture-account-A')
        else {
          await assert.rejects(access(marker), {code:'ENOENT'})
          await writeFile(marker, uid)
        }
      }
      if (!originalA) originalA = account
      else if (uid.endsWith('-A')) assert.deepEqual(account, originalA)
      else assert.notEqual(account.id, originalA.id)
      const returned = await page.evaluate(() => window.hermesLogin.restore())
      assert.deepEqual(Object.keys(returned.account), ['maskedPhone', 'expiresAt'])
      // preload 不转发额外参数，页面不能改变已恢复的主进程身份或目录。
      assert.deepEqual(await page.evaluate(() => window.hermesLogin.restore({uid:'forged', home:'forged-path'})), returned)
      assert.deepEqual(await instance.evaluate(() => globalThis.prepareFixtureAccount()), account)
      assert.deepEqual(await instance.evaluate(() => globalThis.loginProbe.processCalls), [])
      assert.equal(await readFile(path.join(fixture.userData, 'connection.json'), 'utf8'), fixture.oldConnection)
      await assert.rejects(access(fixture.home), {code:'ENOENT'})
    }
    console.log(`P11 加密身份与账号目录组件验收：${fixture.root}`)
  } finally { await instance.close() }
})

test('真实 Electron 启动画面：套餐失败、有套餐和空套餐均后台交接，页面不显示账号或套餐卡片', {timeout:60_000}, async () => {
  const { instance, root, userData, home, oldConnection } = await launchFixture(false, undefined, false, true)
  try {
    const page = await instance.firstWindow()
    await page.getByRole('img').waitFor()
    assert.deepEqual(await page.evaluate(() => window.hermesLogin.plan()), {status:'failed'})
    assert.deepEqual(await instance.evaluate(() => globalThis.loginProbe.planAuthorizations), [])
    await page.locator('#login-phone').fill('13800000000')
    await page.locator('#login-sms').fill('123456')
    await page.getByRole('button', {name:'登录', exact:true}).click()
    await page.getByText('登录失败，请重试。').waitFor()
    await page.getByRole('button', {name:'登录', exact:true}).click()
    await waitForLoginHandoff(instance, page)
    const record = await readFile(path.join(userData, 'maas-login.enc'))
    for (const [index, scenario] of ['failed', 'available', 'empty'].entries()) {
      if (index > 0) await page.reload()
      await waitForLoginHandoff(instance, page)
      await expect.poll(() => instance.evaluate(() => globalThis.loginProbe.planCompleted)).toBe(index + 1)
      if (index === 1) await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(400, 520))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      assert.equal(await page.locator('button, input, h1, section').count(), 0)
      const visible = await page.evaluate(() => document.body.textContent + JSON.stringify({...localStorage}))
      for (const hidden of ['fixture-private-model-key', 'fixture-private-token', 'fixture-private-plan-error',
        'https://models.invalid', 'fixture-plan-model', '138****0000', 'MaaS']) assert.equal(visible.includes(hidden), false)
      await page.screenshot({path:path.join(root, `connecting-${scenario}.png`)})
    }
    assert.deepEqual(await page.evaluate(() => window.hermesLogin.restore()), {
      ok:true, account:{maskedPhone:'138****0000', expiresAt:(await instance.evaluate(() => globalThis.readLoginRecord())).expiresAt}
    })
    assert.equal(await page.locator('form input').count(), 0)
    assert.deepEqual(await instance.evaluate(() => globalThis.loginProbe.planAuthorizations), Array(3).fill('Bearer fixture-private-token'))
    assert.deepEqual(await readFile(path.join(userData, 'maas-login.enc')), record)
    assert.equal(await readFile(path.join(userData, 'connection.json'), 'utf8'), oldConnection)
    assert.deepEqual(await instance.evaluate(() => globalThis.loginProbe.processCalls), [])
    await assert.rejects(access(home), {code:'ENOENT'})
    console.log(`官方同款启动画面与后台套餐链路验收目录：${root}`)
  } finally { await instance.close() }
})

test('P12/P13 真实 Electron 组件：A→B→A 配置与 Key 隔离，轮换保留个人变量，空套餐只撤销专用 Key', {timeout:60_000}, async () => {
  const fixture = await launchFixture()
  const {instance} = fixture
  let firstA
  let accountB
  let personalYaml
  try {
    const page = await instance.firstWindow()
    await page.getByRole('img').waitFor()
    for (const uid of ['fixture-model-A', 'fixture-model-B', 'fixture-model-A']) {
      await instance.evaluate((_, saved) => globalThis.saveLoginRecord(saved), {uid, token:'fixture-only-token', maskedPhone:'138****0000', expiresAt:Date.now()+240_000})
      const key = uid.endsWith('-B') ? 'fixture-B-model-key' : firstA ? 'fixture-A-refreshed-key' : 'fixture-A-model-key'
      await instance.evaluate((_, value) => {globalThis.loginProbe.planKey=value}, key)
      const result = await instance.evaluate(() => globalThis.prepareFixtureEnvironment())
      assert.equal(result.status, 'available')
      const file = path.join(result.account.home, 'config.yaml')
      const yaml = await readFile(file, 'utf8')
      const config = parse(yaml)
      const envFile = path.join(result.account.home, '.env')
      const env = await readFile(envFile, 'utf8')
      assert.equal(parseEnv(env).DESKTOP_MT_MAAS_API_KEY, key)
      assert.equal(env.includes('fixture-only-token'), false)
      assert.equal(yaml.includes(key), false)
      for (const secret of ['fixture-only-token', 'fixture-private-model-key']) assert.equal(yaml.includes(secret), false)
      const providers = Object.values(config.providers).filter(value => value.key_env === 'DESKTOP_MT_MAAS_API_KEY')
      assert.equal(providers.length, 2)
      assert.deepEqual(new Set(providers.map(value => value.api)), new Set(['https://models.invalid/TokenPlan/a/v1', 'https://models.invalid/TokenPlan/b/v1']))
      if (!firstA) {
        firstA = result.account
        config.model = {provider:'custom:personal', default:'my-model'}
        config.providers.personal = {api:'https://personal.invalid/v1', key_env:'PERSONAL_KEY', models:{'my-model':{}}}
        config.mcp_servers = {personal:{command:'keep-tool'}}
        config.skills = {enabled:['keep-skill']}
        personalYaml = '# 保留个人说明\n'+stringify(config)
        await writeFile(file, personalYaml)
        await writeFile(envFile, env+'# 个人 Key 保留\nPERSONAL_KEY=fixture-personal-key\nMCP_KEY=fixture-mcp-key\nMCP_DATA="first\nDESKTOP_MT_MAAS_API_KEY=fixture-nested-key\nlast"\n')
      } else if (uid.endsWith('-A')) {
        assert.deepEqual(result.account, firstA)
        assert.equal(yaml, personalYaml)
        assert.deepEqual(config.model, {provider:'custom:personal', default:'my-model'})
        assert.deepEqual(config.mcp_servers, {personal:{command:'keep-tool'}})
        assert.deepEqual(config.skills, {enabled:['keep-skill']})
        assert.equal(env.includes('# 个人 Key 保留'), true)
        assert.equal(parseEnv(env).PERSONAL_KEY, 'fixture-personal-key')
        assert.equal(parseEnv(env).MCP_KEY, 'fixture-mcp-key')
        assert.equal(env.includes('fixture-A-model-key'), false)
        assert.equal(parseEnv(await readFile(path.join(accountB.home, '.env'), 'utf8')).DESKTOP_MT_MAAS_API_KEY, 'fixture-B-model-key')
      } else {
        assert.notEqual(result.account.id, firstA.id)
        assert.equal(config.providers.personal, undefined)
        assert.equal(config.model.default, 'fixture-plan-default')
        assert.equal(parseEnv(env).PERSONAL_KEY, undefined)
        accountB = result.account
      }
    }
    const currentEnv = await readFile(path.join(firstA.home, '.env'), 'utf8')
    for (const status of ['failed', 'empty']) {
      await instance.evaluate((_, value) => {globalThis.loginProbe.planMode=value}, status)
      const result = await instance.evaluate(() => globalThis.prepareFixtureEnvironment())
      assert.equal(result.status, status)
      assert.equal(await readFile(path.join(firstA.home, 'config.yaml'), 'utf8'), personalYaml)
      const env = await readFile(path.join(firstA.home, '.env'), 'utf8')
      if (status === 'failed') assert.equal(env, currentEnv)
      else {
        assert.equal(parseEnv(env).DESKTOP_MT_MAAS_API_KEY, '')
        assert.equal(parseEnv(env).PERSONAL_KEY, 'fixture-personal-key')
        assert.equal(parseEnv(env).MCP_KEY, 'fixture-mcp-key')
        assert.equal(env.includes('fixture-A-refreshed-key'), false)
      }
    }
    assert.equal(await page.locator('form input').count(), 3)
    assert.equal(await page.evaluate(() => typeof globalThis.prepareFixtureEnvironment), 'undefined')
    assert.deepEqual(await instance.evaluate(() => globalThis.loginProbe.processCalls), [])
    assert.equal(await readFile(path.join(fixture.userData, 'connection.json'), 'utf8'), fixture.oldConnection)
    await assert.rejects(access(fixture.home), {code:'ENOENT'})
    console.log(`P12/P13 加密身份、套餐与 YAML/.env 组件验收：${fixture.root}`)
  } finally { await instance.close() }
})

test('P14 真实登录入口：跨进程 A→B→A 自动准备固定上下文，失败重开和退出阻止迟到写入', {timeout:120_000}, async () => {
  const fixture = await launchFixture()
  let instance = fixture.instance
  let firstA
  try {
    const initialPage = await instance.firstWindow()
    await initialPage.getByRole('img').waitFor()
    assert.equal(await instance.evaluate(() => globalThis.currentFixtureRuntime()), null)
    await assert.rejects(access(path.join(fixture.env.LOCALAPPDATA, 'hermes-desktop-mt')), {code:'ENOENT'})
    // 无账号的旧 UI 提示不能为运行时授权，也不能改变新账号的默认工作目录。
    await writeFile(path.join(fixture.userData, 'active-profile.json'), JSON.stringify({profile:'forged-profile'}))
    await writeFile(path.join(fixture.userData, 'project-dir.json'), JSON.stringify({dir:fixture.home}))
    for (const uid of ['fixture-runtime-A', 'fixture-runtime-B', 'fixture-runtime-A']) {
      await instance.evaluate((_, saved) => globalThis.saveLoginRecord(saved), {
        uid, token:'fixture-runtime-token', maskedPhone:'138****0000', expiresAt:Date.now()+240_000
      })
      await instance.close()
      instance = await electron.launch({executablePath:electronPath, args:[fixture.output], env:fixture.env, timeout:30_000})
      const page = await instance.firstWindow()
      await waitForLoginHandoff(instance, page)
      const state = await instance.evaluate(() => globalThis.currentFixtureRuntime())
      assert.ok(state)
      assert.equal(state.frozen, true)
      assert.equal(state.context.installationRoot, fixture.env.HERMES_DESKTOP_HERMES_ROOT)
      assert.equal(state.pythonPath, fixture.env.HERMES_DESKTOP_HERMES_ROOT)
      assert.equal(state.source, state.context.installationRoot)
      assert.equal(state.context.python, state.python)
      assert.equal(state.parentHome, fixture.home)
      assert.equal(state.context.home.startsWith(path.join(fixture.env.LOCALAPPDATA, 'hermes-desktop-mt', 'accounts')), true)
      assert.equal(state.context.desktopState.startsWith(path.join(fixture.userData, 'accounts')), true)
      assert.notEqual(state.context.workspace, fixture.home)
      for (const directory of [state.context.home, state.context.workspace, state.context.desktopState]) {
        const marker = path.join(directory, 'runtime-marker')
        if (uid.endsWith('-A') && firstA) assert.equal(await readFile(marker, 'utf8'), 'A-data-kept')
        else {
          await assert.rejects(access(marker), {code:'ENOENT'})
          await writeFile(marker, uid.endsWith('-A') ? 'A-data-kept' : 'B-data-kept')
        }
      }
      if (!firstA) firstA = state
      else if (uid.endsWith('-A')) assert.deepEqual(state, firstA)
      else {
        assert.notEqual(state.context.id, firstA.context.id)
        assert.equal(state.python, firstA.python)
      }
      const returned = await page.evaluate(() => window.hermesLogin.plan({uid:'forged', home:'forged-path'}))
      assert.deepEqual(Object.keys(returned), ['status', 'models'])
      assert.deepEqual(await instance.evaluate(() => globalThis.currentFixtureRuntime()), state)
      const visible = await page.evaluate(() => document.body.textContent + JSON.stringify({...localStorage}))
      for (const secret of [uid, 'fixture-runtime-token', 'fixture-private-model-key', state.context.id, state.context.home]) assert.equal(visible.includes(secret), false)
      assert.equal(await page.evaluate(() => typeof globalThis.currentFixtureRuntime), 'undefined')
      assert.deepEqual(await instance.evaluate(() => globalThis.loginProbe.processCalls), [])
      assert.equal(await readFile(path.join(fixture.userData, 'connection.json'), 'utf8'), fixture.oldConnection)
      await assert.rejects(access(fixture.home), {code:'ENOENT'})
    }
    let page = await instance.firstWindow()
    const envFile = path.join(firstA.context.home, '.env')
    const oldEnv = await readFile(envFile, 'utf8')
    await mkdir(`${envFile}.tmp`)
    await instance.evaluate(() => {
      globalThis.loginProbe.planKey='fixture-runtime-updated-key'
      globalThis.loginProbe.holdEnvironmentError=true
    })
    assert.equal((await page.evaluate(() => window.hermesLogin.plan())).status, 'available')
    assert.equal(await instance.evaluate(() => globalThis.currentFixtureRuntime()), null)
    assert.equal(await readFile(envFile, 'utf8'), oldEnv)
    const message = await instance.evaluate(() => globalThis.loginProbe.environmentError)
    assert.ok(message.includes('无法安全保存账号凭据。') && message.includes('完整退出应用后重新打开'))
    await rmdir(`${envFile}.tmp`)
    // P23 已封闭失败准备；移除测试故障也不能在同一进程直接重试。
    await page.evaluate(() => window.hermesLogin.plan())
    assert.equal(await instance.evaluate(() => globalThis.currentFixtureRuntime()), null)
    assert.equal(await readFile(envFile, 'utf8'), oldEnv)
    const exited = once(instance.process(), 'exit')
    await instance.evaluate(() => globalThis.loginProbe.environmentAnswer({response:0, checkboxChecked:false}))
    assert.equal((await exited)[0], 0)
    instance = null
    instance = await electron.launch({executablePath:electronPath, args:[fixture.output], env:fixture.env, timeout:30_000})
    page = await instance.firstWindow()
    await waitForLoginHandoff(instance, page)
    assert.deepEqual(await instance.evaluate(() => globalThis.currentFixtureRuntime()), firstA)
    const beforeQuit = await readFile(envFile, 'utf8')
    await instance.evaluate(() => {globalThis.loginProbe.planKey='fixture-must-not-write-key'})
    const started = instance.evaluate(() => globalThis.waitForFixturePlan())
    const pending = page.evaluate(() => window.hermesLogin.plan())
    await started
    await instance.evaluate(({app}) => app.emit('will-quit', {preventDefault(){}}))
    await pending
    assert.equal(await instance.evaluate(() => globalThis.currentFixtureRuntime()), null)
    assert.equal(await readFile(envFile, 'utf8'), beforeQuit)
    assert.deepEqual(await page.evaluate(() => window.hermesLogin.restore()), {ok:false})
    assert.deepEqual(await instance.evaluate(() => globalThis.loginProbe.processCalls), [])
    console.log(`P14 真实登录入口与固定运行上下文验收：${fixture.root}`)
  } finally { await instance?.close() }
})

test('真实 MaaS 图片在登录窗口展示并可刷新，其他窗口与子框架无权请求', {
  timeout: 60_000, skip: process.env.HERMES_LOGIN_LIVE_CAPTCHA !== '1'
}, async () => {
  const { instance, root, home, rendererRoot } = await launchFixture(false, undefined, true)
  try {
    const page = await instance.firstWindow()
    const image = page.getByRole('img', { name: '图形验证码' })
    await image.waitFor({ timeout: 20_000 })
    await expect.poll(() => image.evaluate(node => node.naturalWidth)).toBeGreaterThan(0)
    await image.click()
    await image.waitFor({ timeout: 20_000 })
    await expect.poll(() => image.evaluate(node => node.naturalWidth)).toBeGreaterThan(0)
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
