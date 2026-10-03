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
  const globalSentinels = {
    'native-oauth-tokens.json': '{}',
    'secure-token-storage.json': '{"on":true,"migrated":true}',
    'managed-ssh-update-recovery.json': '{"fixture":"old-global-recovery"}',
    'favicon-cache.json': '{"icons":{"old-global.invalid":{"at":0,"icon":"old-icon"}}}',
    'plugin-compat-dismissed.json': '{"keys":["pending|fixture-plugin:1"]}'
  }
  for (const [name, content] of Object.entries(globalSentinels)) await writeFile(path.join(userData,name),content)
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
      return {response:1, checkboxChecked:false}
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
      const uid = process.env.FIXTURE_UID || 'fixture-desktop-account'
      if (store.load()?.uid !== uid) store.save({
        namespace:'maas.ai-yuanjing.com/uniwork', uid,
        token:'fixture-login-token', maskedPhone:'138****0000', expiresAt:Date.now()+600_000
      })
    })
    await import('./electron/entry')
    const {currentDesktopLocalContext} = await import('./electron/login/bootstrap')
    globalThis.fixtureContext = () => currentDesktopLocalContext()
    globalThis.fixtureOpenDesktop = () => import('./electron/main').then(module => module.openAccountDesktop())
    globalThis.fixtureMain = () => import('./electron/main').then(module => module.fixtureNativeState)
  `}, bundle:true, format:'esm', platform:'node', target:'node20',
  external:['electron','node-pty','get-windows'], outfile:output,
  define:{__HERMES_PRODUCT_IDENTITY__:JSON.stringify(createRequire(import.meta.url)(path.join(desktop,'product-identity.cjs')))},
  plugins:[{name:'observe-runtime-error', setup(builder) {
    builder.onLoad({filter:/entry_local[\\/]desktop-runtime\.ts$/}, async args => ({loader:'ts',
      contents:(await readFile(args.path,'utf8')).replace("await import('../main')",
        "await import('../main').catch(error => {globalThis.fixtureImportError=error.stack; throw error})"),
      resolveDir:path.dirname(args.path)}))
    // 只观察正式存储函数，不替换路径、读写、系统加密或后端。
    builder.onLoad({filter:/electron[\\/]main\.ts$/}, async args => ({loader:'ts',
      contents:(await readFile(args.path,'utf8')) + `
        export const fixtureNativeState = {paths:ACCOUNT_DESKTOP_STATE,
          storeTokens:_storeNativeTokens, loadTokens:_loadNativeTokens,
          iconCache:loadFaviconCache, saveIcons:saveFaviconCacheSoon,
          pluginNotice:showPluginCompatNoticeOnce}
      `, resolveDir:path.dirname(args.path)}))
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
  return {root, userData, output, env, globalSentinels}
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

test('P15/P16 原生 Electron：自动进入账号桌面，REST/WS 鉴权与 A→B→A 桌面存储隔离',
  {timeout:360_000}, async () => {
    const {server,url} = await startLoginDevServer()
    let instance
    const fixture = await prepareFixture(url)
    console.log(`隔离桌面夹具目录：${fixture.root}`)
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
      let accountA
      let preservedA
      for (const [scenario, uid, plan] of [
        ['empty','fixture-desktop-account','empty'],
        ['failed','fixture-desktop-account','failed'],
        ['available','fixture-desktop-account','available'],
        ['account-b','fixture-desktop-account-b','empty'],
        ['account-a-return','fixture-desktop-account','available']
      ]) {
        instance = await electron.launch({executablePath:electronPath,args:[fixture.output],
          env:{...fixture.env,FIXTURE_PLAN:plan,FIXTURE_UID:uid},timeout:45_000})
        const diagnostics = []
        instance.process().stderr.on('data', chunk => diagnostics.push(chunk.toString()))
        const page = await chatWindow(instance, diagnostics)
        for (const login of instance.windows().filter(page => page.url().includes('login.html'))) {
          await login.waitForEvent('close',{timeout:15_000})
        }
        const context = await instance.evaluate(() => globalThis.fixtureContext())
        accountA ??= context
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
        if (scenario === 'empty') loginRecord = currentRecord
        else if (scenario === 'failed' || scenario === 'available') assert.deepEqual(currentRecord,loginRecord)
        if (plan === 'available') {
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
        else if (scenario === 'account-b') await assert.rejects(access(marker),{code:'ENOENT'})
        else assert.equal(await readFile(marker,'utf8'),'fixture-owned-file')
        const statePaths = await instance.evaluate(async () => (await globalThis.fixtureMain()).paths)
        for (const value of Object.values(statePaths)) assert.equal(path.dirname(value),context.desktopState)
        const isA = context.id === accountA.id
        const project = path.join(context.workspace,'fixture-project')
        const preferences = await page.evaluate(async () => ({
          project:await window.hermesDesktop.settings.getDefaultProjectDir(),
          encryption:await window.hermesDesktop.getSecretStorageEncryption(),
          profile:await window.hermesDesktop.profile.getDefault(),
          connections:await window.hermesDesktop.connections.list()
        }))
        if (scenario === 'empty' || scenario === 'account-b') {
          assert.deepEqual(preferences.encryption,{on:false})
          assert.equal(preferences.profile,null)
          assert.equal(preferences.connections.connections.some(item => item.label === 'fixture-account-route'),false)
          await mkdir(project)
          await page.evaluate(async ({project,isA}) => {
            await window.hermesDesktop.settings.setDefaultProjectDir(project)
            await window.hermesDesktop.profile.remember('default')
            await window.hermesDesktop.profile.setDefault({connectionId:'local',profile:'default'})
            await window.hermesDesktop.setSecretStorageEncryption(isA)
            await window.hermesDesktop.connections.save({kind:'remote',label:'fixture-account-route',
              url:'https://fixture.invalid',authMode:'token',token:isA?'fixture-route-a':'fixture-route-b'})
          },{project,isA})
        } else {
          assert.equal(preferences.project.dir,project)
          assert.deepEqual(preferences.encryption,{on:true})
          assert.equal(preferences.profile.profile,'default')
          assert.equal(preferences.connections.connections.filter(item => item.label === 'fixture-account-route').length,1)
        }
        const nativeState = await instance.evaluate(async (_electron, {id,first}) => {
          const main = await globalThis.fixtureMain()
          const url = 'https://fixture.invalid'
          const before = main.loadTokens(url)
          const icons = main.iconCache()
          const cached = icons.get('same-account-host.invalid')?.icon ?? null
          if (first) main.storeTokens(url,{userId:id,accessToken:'fixture-access-'+id,refreshToken:'fixture-refresh-'+id,
            provider:'fixture',expiresAt:Math.floor(Date.now()/1000)+600})
          icons.set('same-account-host.invalid',{at:Date.now(),icon:id})
          main.saveIcons()
          return {before:before?.userId ?? null,after:main.loadTokens(url)?.userId,cached}
        },{id:context.id,first:scenario === 'empty' || scenario === 'account-b'})
        assert.equal(nativeState.before,scenario === 'empty' || scenario === 'account-b' ? null : context.id)
        assert.equal(nativeState.after,context.id)
        assert.equal(nativeState.cached,scenario === 'empty' || scenario === 'account-b' ? null : context.id)
        const report = {removal_date:'2026-09-14',in_effect:false,lines:['fixture notice','fixture detail'],
          plugins:{'fixture-plugin':[{file:'fixture.py',line:1,old:'fixture.old',new:'fixture.new'}]}}
        await writeFile(path.join(context.home,'.plugin-compat-report.json'),JSON.stringify(report))
        const dialogs = await instance.evaluate(() => globalThis.fixtureErrors.length)
        await instance.evaluate(async () => (await globalThis.fixtureMain()).pluginNotice())
        assert.equal(await instance.evaluate(() => globalThis.fixtureErrors.length),
          dialogs + (scenario === 'empty' || scenario === 'account-b' ? 1 : 0))
        const image = await page.evaluate(async () => window.hermesDesktop.saveImageBuffer(
          [137,80,78,71,13,10,26,10],'.png','same-session-attachment'))
        assert.equal(path.dirname(image),statePaths.composerImages)
        assert.deepEqual([...await readFile(image)],[137,80,78,71,13,10,26,10])
        if (scenario === 'empty') preservedA = image
        else if (scenario === 'account-b') assert.notEqual(path.dirname(image),path.dirname(preservedA))
        else await access(preservedA)
        // 同一进程的新 Map 只由自己的文件恢复；等实际防抖写入，不以 sleep 猜成功。
        const iconDeadline = Date.now()+10_000
        let savedIcon
        while (Date.now()<iconDeadline) {
          try {
            savedIcon = JSON.parse(await readFile(statePaths.faviconCache,'utf8'))
              .icons['same-account-host.invalid']?.icon
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
          if (savedIcon === context.id) break
          await new Promise(resolve => setTimeout(resolve,100))
        }
        assert.equal(savedIcon,context.id)
        if (scenario === 'account-b') {
          assert.equal(JSON.parse(await readFile(path.join(accountA.desktopState,'native-oauth-tokens.json'),'utf8'))
            ['https://fixture.invalid'].encoding,'safeStorage')
          assert.equal(JSON.parse(await readFile(path.join(accountA.desktopState,'project-dir.json'),'utf8')).dir,
            path.join(accountA.workspace,'fixture-project'))
        }
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
      for (const [name,content] of Object.entries(fixture.globalSentinels)) {
        assert.equal(await readFile(path.join(fixture.userData,name),'utf8'),content)
      }
      console.log(`P15/P16 原版桌面真实链路验收目录：${fixture.root}`)
    } finally {
      await instance?.close()
      await server.close()
    }
  })
