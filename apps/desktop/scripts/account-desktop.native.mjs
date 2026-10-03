import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

import { _electron as electron } from '@playwright/test'
import electronPath from 'electron'
import { build } from 'esbuild'

import { prepareLoginRenderer, startLoginDevServer } from './login-renderer.fixture.mjs'

const desktop = path.resolve(import.meta.dirname, '..')

/** 使用正式入口和原版主进程；只有 MaaS 响应受控，账号文件和 Hermes 子进程均真实。 */
async function prepareFixture(url) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-mt-desktop-'))
  const renderer = await prepareLoginRenderer()
  const userData = path.join(root, 'user-data')
  await mkdir(userData)
  await writeFile(path.join(userData, 'connection.json'), '{"mode":"remote","url":"http://127.0.0.1:1"}')
  await writeFile(path.join(userData, 'active-profile.json'), '{"profile":"old-account-profile"}')
  const cache = path.join(desktop, 'node_modules', '.cache')
  await mkdir(cache, {recursive:true})
  const output = path.join(await mkdtemp(path.join(cache, 'desktop-mt-native-')), 'main.mjs')
  for (const [input, filename] of [
    ['preload.ts','electron-preload.js'], ['preview-guest-preload-entry.ts','preview-guest-preload.js']
  ]) {
    await build({entryPoints:[path.join(desktop,'electron',input)], bundle:true, platform:'node',
      format:'cjs', external:['electron'], outfile:path.join(renderer,'dist',filename)})
  }
  await build({stdin:{resolveDir:desktop, contents:`
    import {app, dialog, net} from 'electron'
    import {CredentialStore} from './electron/login/credential-store'
    app.setAppPath(${JSON.stringify(renderer)})
    // 夹具不修改 Windows URL 关联；产品使用独立的桌面开发版 scheme。
    globalThis.fixtureProtocols = []
    globalThis.fixtureErrors = []
    globalThis.fixturePreloadErrors = []
    app.on('web-contents-created', (_event, contents) => {
      contents.on('preload-error', (_event, filename, error) => globalThis.fixturePreloadErrors.push(error.stack))
    })
    dialog.showMessageBox = async (_window, options) => {
      globalThis.fixtureErrors.push(options.message)
      return {response:0, checkboxChecked:false}
    }
    app.setAsDefaultProtocolClient = scheme => {globalThis.fixtureProtocols.push(scheme); return false}
    const originalFetch = net.fetch
    net.fetch = (...args) => String(args[0]).startsWith('https://maas.ai-yuanjing.com/') ?
      Promise.resolve(process.env.FIXTURE_PLAN === 'failed' ? new Response('',{status:503}) :
        process.env.FIXTURE_PLAN === 'available' ? Response.json({apiKey:'fixture-only-model-key',
          models:{models:[{id:'fixture',model:'fixture-desktop-model',base_url:'https://models.invalid/v1'}]}}) :
        Response.json({apiKey:null, models:null})) : originalFetch(...args)
    // 真实系统加密，完整可信身份只在主进程，页面不传 UID 或 token。
    app.whenReady().then(() => {
      if (process.env.FIXTURE_LOGIN_DISABLE === '1') return
      const store = new CredentialStore(app.getPath('userData'))
      if (!store.load()) store.save({
        namespace:'maas.ai-yuanjing.com/uniwork', uid:'fixture-desktop-account',
        token:'fixture-login-token', maskedPhone:'138****0000', expiresAt:Date.now()+600_000
      })
    })
    await import('./electron/entry')
    const {currentDesktopLocalContext} = await import('./electron/login/bootstrap')
    globalThis.fixtureContext = () => currentDesktopLocalContext()
    globalThis.fixtureOpenDesktop = () => import('./electron/main').then(module => module.openAccountDesktop())
  `}, bundle:true, format:'esm', platform:'node', target:'node20',
  external:['electron','node-pty','get-windows'], outfile:output,
  define:{__HERMES_PRODUCT_IDENTITY__:JSON.stringify(createRequire(import.meta.url)(path.join(desktop,'product-identity.cjs')))},
  plugins:[{name:'observe-runtime-error', setup(builder) {
    builder.onLoad({filter:/entry_local[\\/]desktop-runtime\.ts$/}, async args => ({loader:'ts',
      contents:(await readFile(args.path,'utf8')).replace("await import('../main')",
        "await import('../main').catch(error => {globalThis.fixtureImportError=error.stack; throw error})"),
      resolveDir:path.dirname(args.path)}))
  }}],
  banner:{js:`import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(path.join(desktop,'dist','electron-main.mjs'))});`}})
  const env = {...process.env, LOCALAPPDATA:path.join(root,'local-app-data'),
    HERMES_HOME:path.join(root,'unused-old-home'), HERMES_DESKTOP_USER_DATA_DIR:userData,
    HERMES_DESKTOP_HERMES_ROOT:path.resolve(desktop,'../..'), HERMES_DESKTOP_DEV_SERVER:url,
    HERMES_DESKTOP_CDP_PORT:'off', HERMES_DESKTOP_SKIP_QUIT_CONFIRM:'1', HERMES_SKIP_INTRO:'1',
    HERMES_DESKTOP_DISABLE_GPU:'1',
    HERMES_GUEST_ONBOARDING:'0', HERMES_DESKTOP_APP_NAME:'Hermes Desktop MT Test'}
  delete env.ELECTRON_RUN_AS_NODE
  delete env.HERMES_DESKTOP_PYTHON
  return {root, userData, output, env}
}

/** 等待自动交接后的原生聊天窗，不操作用户已有窗口。 */
async function chatWindow(instance, diagnostics) {
  const deadline = Date.now()+90_000
  while (Date.now()<deadline) {
    const errors = await instance.evaluate(() => globalThis.fixtureErrors)
    if (errors.length) {
      const detail = await instance.evaluate(async () => {
        if (globalThis.fixtureImportError) return globalThis.fixtureImportError
        try { await globalThis.fixtureOpenDesktop(); return 'no error' }
        catch (error) {return error.stack}
      })
      throw new Error(`${errors.join('；')}\n${detail}`)
    }
    const page = instance.windows().find(page => !page.url().includes('login.html') && page.url().startsWith('http'))
    if (page) {
      try {
        // 首次原版窗口隐藏到主题首帧；不能依赖隐藏窗的 requestAnimationFrame 来轮询桥接。
        await page.waitForFunction(() => typeof window.hermesDesktop?.getConnection === 'function', null,
          {polling:100, timeout:120_000})
        await page.waitForLoadState('domcontentloaded', {timeout:120_000})
      } catch (error) {
        const state = await instance.evaluate(({app,BrowserWindow}) => ({
          appPath:app.getAppPath(),
          errors:globalThis.fixturePreloadErrors,
          windows:BrowserWindow.getAllWindows().map(window => ({url:window.webContents.getURL(),
            prefs:window.webContents.getLastWebPreferences()}))
        })).catch(() => ({process:diagnostics}))
        throw new Error(JSON.stringify({state, page:await page.evaluate(() => ({url:location.href, login:typeof window.hermesLogin,
          desktop:typeof window.hermesDesktop, getConnection:typeof window.hermesDesktop?.getConnection,
          keys:Object.keys(window.hermesDesktop ?? {}), text:document.body.textContent?.slice(0,400)}))}))
      }
      return page
    }
    await new Promise(resolve => setTimeout(resolve,250))
  }
  throw new Error('登录后没有自动进入原生聊天窗。')
}

test('P15 原生 Electron：空、失败与有效套餐均自动进入账号桌面，REST/WS 鉴权、重复连接及重开复用',
  {timeout:360_000}, async () => {
    const {server,url} = await startLoginDevServer()
    let instance
    const fixture = await prepareFixture(url)
    try {
      instance = await electron.launch({executablePath:electronPath,args:[fixture.output],
        env:{...fixture.env,FIXTURE_LOGIN_DISABLE:'1'},timeout:45_000})
      const login = await instance.firstWindow()
      await login.getByRole('heading',{name:'登录 Hermes'}).waitFor()
      assert.equal(await login.evaluate(() => typeof window.hermesDesktop),'undefined')
      assert.equal(await instance.evaluate(() => globalThis.fixtureContext()),null)
      await assert.rejects(access(path.join(fixture.root,'local-app-data','hermes-desktop-mt','accounts')),{code:'ENOENT'})
      await instance.close()
      instance = null
      let loginRecord
      for (const scenario of ['empty','failed','available']) {
        instance = await electron.launch({executablePath:electronPath,args:[fixture.output],
          env:{...fixture.env,FIXTURE_PLAN:scenario},timeout:45_000})
        const diagnostics = []
        instance.process().stderr.on('data', chunk => diagnostics.push(chunk.toString()))
        const page = await chatWindow(instance, diagnostics)
        for (const login of instance.windows().filter(page => page.url().includes('login.html'))) {
          await login.waitForEvent('close',{timeout:15_000})
        }
        const context = await instance.evaluate(() => globalThis.fixtureContext())
        assert.equal(context.installationRoot,path.resolve(desktop,'../..'))
        assert.ok(context.home.startsWith(path.join(fixture.root,'local-app-data','hermes-desktop-mt','accounts')))
        assert.equal(await page.evaluate(() => typeof window.hermesLogin),'undefined')
        assert.equal(instance.windows().some(page => page.url().includes('login.html')),false)
        const connections = await page.evaluate(() => Promise.all(Array.from({length:3}, () => window.hermesDesktop.getConnection())))
        assert.equal(new Set(connections.map(item => item.baseUrl)).size,1)
        const connection = connections[0]
        assert.equal(new URL(connection.baseUrl).hostname,'127.0.0.1')
        assert.ok(connection.token.length >= 32)
        assert.notEqual(connection.token,'fixture-login-token')
        const status = await page.evaluate(() => window.hermesDesktop.api({method:'GET',path:'/api/status'}))
        assert.ok(status)
        const rejected = await fetch(`${connection.baseUrl}/api/profiles`)
        assert.equal(rejected.status,401)
        const authorized = await fetch(`${connection.baseUrl}/api/profiles`,{headers:{Authorization:`Bearer ${connection.token}`}})
        assert.equal(authorized.status,200)
        const ws = await page.evaluate(async () => {
          const result = await window.hermesDesktop.getGatewayWsUrl()
          if (!result.ok) return {ok:false}
          return new Promise(resolve => {
            const socket = new WebSocket(result.wsUrl)
            const timer = setTimeout(() => {socket.close();resolve({ok:false})},15_000)
            socket.onmessage = event => {clearTimeout(timer);socket.close();resolve({ok:true,hasFrame:Boolean(event.data)})}
            socket.onerror = () => {clearTimeout(timer);socket.close();resolve({ok:false})}
          })
        })
        assert.deepEqual(ws,{ok:true,hasFrame:true})
        await readFile(path.join(context.home,'state.db'))
        const currentRecord = await readFile(path.join(fixture.userData,'maas-login.enc'))
        if (loginRecord) assert.deepEqual(currentRecord,loginRecord)
        else loginRecord = currentRecord
        if (scenario === 'available') {
          const config = await readFile(path.join(context.home,'config.yaml'),'utf8')
          assert.ok(config.includes('fixture-desktop-model') && config.includes('DESKTOP_MT_MAAS_API_KEY'))
          assert.equal(config.includes('fixture-only-model-key'),false)
          const env = await readFile(path.join(context.home,'.env'),'utf8')
          assert.ok(env.includes('fixture-only-model-key'))
          await page.locator('textarea,[contenteditable="true"]').first().waitFor({timeout:60_000})
          await page.getByText('Fixture Desktop Model',{exact:true}).first().waitFor({timeout:60_000})
        }
        const marker = path.join(context.workspace,'p15-preserved.txt')
        if (scenario === 'empty') await writeFile(marker,'fixture-owned-file')
        else assert.equal(await readFile(marker,'utf8'),'fixture-owned-file')
        await page.screenshot({path:path.join(fixture.root,`desktop-${scenario}.png`)})
        const ledger = JSON.parse(await readFile(path.join(context.home,'spawn-ledger.json'),'utf8'))
          .find(record => record.port === Number(new URL(connection.baseUrl).port) && record.purpose === 'serve')
        assert.ok(Number.isInteger(ledger?.pid) && ledger.pid > 0)
        assert.deepEqual(await instance.evaluate(() => globalThis.fixtureProtocols),['hermes-desktop-mt'])
        await instance.close()
        instance = null
        // 只检查该夹具账本中的进程，不停止或枚举全机 Hermes。
        assert.throws(() => process.kill(ledger.pid,0), {code:'ESRCH'})
      }
      assert.equal(await readFile(path.join(fixture.userData,'connection.json'),'utf8'),'{"mode":"remote","url":"http://127.0.0.1:1"}')
      console.log(`P15 原版桌面真实链路验收目录：${fixture.root}`)
    } finally {
      await instance?.close()
      await server.close()
    }
  })
