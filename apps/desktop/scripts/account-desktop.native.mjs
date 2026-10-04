import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { createServer } from 'node:http'
import {spawn, execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {once} from 'node:events'

import { _electron as electron } from '@playwright/test'
import electronPath from 'electron'
import { build } from 'esbuild'

import { prepareLoginRenderer, startLoginDevServer } from './login-renderer.fixture.mjs'
import { superviseElectron } from './dev-electron.mjs'
import { gatewayOperation } from './gateway-logout.fixture.mjs'
import { exerciseExitFailure } from './account-exit-failure.fixture.mjs'
import { exerciseAccountRecovery } from './account-recovery.fixture.mjs'

const desktop = path.resolve(import.meta.dirname, '..')

for (const mode of ['running','logout','expired']) {
test(`P25 真实 Electron：${mode} 崩溃后先清理旧工作，再按原身份规则打开`, {timeout:420_000}, async () => {
  const {server,url}=await startLoginDevServer()
  const fixture=await prepareFixture(url)
  console.log(`P25 恢复夹具：${fixture.root}`)
  try {await exerciseAccountRecovery(fixture,mode)}
  finally {await server.close()}
})
}

for (const closeFailure of [false,true]) {
test(closeFailure ? 'P24 真实 Electron：关闭失败应用保留记录，重开不放行账号' :
  'P24 真实 Electron：归属不明、停止超时、拒绝与残留阻止退出，显式重试收尾', {timeout:420_000}, async () => {
  const {server,url}=await startLoginDevServer()
  const fixture=await prepareFixture(url)
  console.log(`P24 退出故障夹具：${fixture.root}`)
  try {await exerciseExitFailure(fixture,closeFailure)}
  finally {await server.close()}
})
}

test('P23 真实 Electron：配置、启动与健康失败安全退出，修复后重开复用数据且无重复后端', {timeout:420_000}, async () => {
  const {server,url}=await startLoginDevServer()
  const fixture=await prepareFixture(url)
  console.log(`P23 启动故障夹具：${fixture.root}`)
  let instance
  let probes=0
  const unhealthy=createServer((_request,response)=>{probes++;response.writeHead(503);response.end('{}')})
  await new Promise(resolve=>unhealthy.listen(0,'127.0.0.1',resolve))
  try {
    instance=await electron.launch({executablePath:electronPath,args:[fixture.output],
      env:{...fixture.env,FIXTURE_PLAN:'available'},timeout:45_000})
    let page=await chatWindow(instance,[])
    await page.evaluate(()=>window.hermesDesktop.getConnection())
    const context=await instance.evaluate(()=>globalThis.fixtureContext())
    const config=path.join(context.home,'config.yaml')
    const original=await readFile(config,'utf8')
    const encrypted=await readFile(path.join(fixture.userData,'maas-login.enc'))
    const marker=path.join(context.workspace,'p23-history-sentinel.txt')
    await writeFile(marker,'preserve fixture account files')
    await instance.close(); instance=null
    const history=await readFile(path.join(context.home,'state.db'))
    for (const kind of ['config','exit','health']) {
      console.log(`P23 验证：${kind}`)
      if (kind==='config') await writeFile(config,'personal: [unclosed\n# private-key\n')
      instance=await electron.launch({executablePath:electronPath,args:[fixture.output],
        env:{...fixture.env,FIXTURE_PLAN:'available',FIXTURE_HOLD_STARTUP_FAILURE:'1',
          FIXTURE_FAIL_BACKEND:kind,FIXTURE_HEALTH_PORT:String(unhealthy.address().port)},timeout:45_000})
      const deadline=Date.now()+90_000
      let prompt
      while(Date.now()<deadline) {
        prompt=await instance.evaluate(()=>globalThis.fixtureStartupDialog)
        if(prompt) break
        await new Promise(resolve=>setTimeout(resolve,100))
      }
      assert.ok(prompt,'必须清楚显示启动失败')
      assert.ok(prompt.message.includes('完整退出应用后重新打开'))
      assert.ok(prompt.message.includes(kind==='config'?'账号配置':'本地服务'))
      assert.equal(/private-key|fixture-only-model-key|fixture-login-token|Traceback|config.yaml/.test(prompt.message),false)
      assert.deepEqual(prompt.buttons,['退出应用'])
      assert.deepEqual(await readFile(path.join(fixture.userData,'maas-login.enc')),encrypted)
      assert.equal(await readFile(marker,'utf8'),'preserve fixture account files')
      if(kind==='config') {
        assert.equal(await instance.evaluate(()=>globalThis.fixtureContext()),null)
        assert.deepEqual(await readFile(path.join(context.home,'state.db')),history)
        assert.equal(await readFile(config,'utf8'),'personal: [unclosed\n# private-key\n')
      }
      const pids=await instance.evaluate(()=>globalThis.fixtureFailedPids)
      if(kind!=='config') {
        const failures=await instance.evaluate(async()=>{
          const state=await globalThis.fixtureMain()
          return Promise.all(Array.from({length:3},()=>state.startBackend().then(()=>null,error=>error.message)))
        })
        assert.ok(failures.every(message=>message===prompt.message),'重复请求必须保持同一失败')
        assert.equal(pids.length,1)
        assert.deepEqual(await instance.evaluate(()=>globalThis.fixtureFailedPids),pids)
      }
      const childProcess=instance.process()
      const exited=once(childProcess,'exit')
      await instance.evaluate(()=>globalThis.fixtureStartupAnswer({response:0,checkboxChecked:false}))
      const [code]=await exited
      assert.equal(code,0)
      instance=null
      for(const pid of pids) assert.throws(()=>globalThis.process.kill(pid,0),{code:'ESRCH'})
      await assert.rejects(access(path.join(fixture.userData,'maas-logout-pending.json')),{code:'ENOENT'})
      if(kind==='config') await writeFile(config,original)
    }
    assert.ok(probes>0,'健康失败必须经过真实 HTTP 探测')
    instance=await electron.launch({executablePath:electronPath,args:[fixture.output],env:fixture.env,timeout:45_000})
    page=await chatWindow(instance,[])
    const connections=await page.evaluate(()=>Promise.all(Array.from({length:3},()=>window.hermesDesktop.getConnection())))
    assert.equal(new Set(connections.map(row=>row.baseUrl)).size,1)
    assert.equal((await instance.evaluate(()=>globalThis.fixtureContext())).id,context.id)
    assert.equal(await readFile(marker,'utf8'),'preserve fixture account files')
    assert.deepEqual(await readFile(path.join(fixture.userData,'maas-login.enc')),encrypted)
    await page.evaluate(()=>window.hermesDesktop.api({method:'GET',path:'/api/status'}))
    await page.screenshot({path:path.join(fixture.root,'p23-reopened.png')})
  } finally {
    await instance?.close()
    await new Promise(resolve=>unhealthy.close(resolve))
    await server.close()
  }
})

test('P22 真实套餐鉴权拒绝：进入桌面后仍提示重登，不清身份或停止后端', {timeout:240_000}, async () => {
  const {server,url}=await startLoginDevServer()
  const fixture=await prepareFixture(url)
  console.log(`P22 拒绝提示夹具：${fixture.root}`)
  let instance
  try {
    instance=await electron.launch({executablePath:electronPath,args:[fixture.output],
      env:{...fixture.env,FIXTURE_PLAN:'rejected'},timeout:45_000})
    const page=await chatWindow(instance,[])
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>
      w.webContents.getURL().startsWith('http') && !w.webContents.getURL().includes('login.html')).show())
    // 无套餐的新账号沿用原版模型引导；先明确跳过，再验收桌面提示与可点击的退出。
    await page.getByText('稍后再选择提供方',{exact:true}).click({timeout:60_000})
    try {
      await page.getByText('MaaS 拒绝了当前登录凭据，请退出账号后重新登录。',{exact:true}).waitFor({timeout:60_000})
    } catch (error) {
      await page.screenshot({path:path.join(fixture.root,'plan-rejected-failed.png')})
      throw error
    }
    await page.locator('[data-slot=statusbar]').getByRole('button',{name:'退出',exact:true}).waitFor()
    await page.locator('[data-slot=statusbar]').getByRole('button',{name:'退出',exact:true}).click({trial:true,timeout:45_000})
    const account=await page.evaluate(()=>window.hermesDesktop.getMaasAccount())
    assert.equal(account.planAuthRejected,true)
    assert.deepEqual(Object.keys(account).sort(),['expiresAt','maskedPhone','planAuthRejected'])
    assert.ok(await instance.evaluate(()=>globalThis.fixtureContext()))
    await page.evaluate(()=>window.hermesDesktop.getConnection())
    await access(path.join(fixture.userData,'maas-login.enc'))
    const record = JSON.parse(await readFile(path.join(fixture.userData,'maas-logout-pending.json'),'utf8'))
    assert.equal(record.mode,'quit')
    assert.equal(record.account,(await instance.evaluate(()=>globalThis.fixtureContext())).id)
    await page.screenshot({path:path.join(fixture.root,'plan-rejected.png')})
  } finally {
    await instance?.close()
    await server.close()
  }
})

test('P21 原版 Cron：停机后周期补跑一次、关闭补跑和过期一次性跳过', {timeout:30_000}, async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'hermes-p21-cron-'))
  await promisify(execFile)(process.env.FIXTURE_PYTHON || path.resolve(desktop,'../../.venv/Scripts/python.exe'),
    [path.join(desktop,'scripts/account-work.fixture.py'),'cron-policy',root],{
      cwd:path.resolve(desktop,'../..'),windowsHide:true,timeout:25_000,
      env:{...process.env,HERMES_HOME:root,PYTHONPATH:path.resolve(desktop,'../..')}})
  assert.deepEqual(JSON.parse(await readFile(path.join(root,'cron-policy.json'),'utf8')),
    {defaultCatchUpOnce:true,disabledCatchUpSkipped:true,expiredOneShotSkipped:true})
})

for (const mode of ['window','tray']) {
  test(`P21 真实 ${mode} 退出：托盘工作继续，退出停止四类进程并保留登录`, {timeout:240_000}, async () => {
    const {server,url}=await startLoginDevServer()
    const fixture=await prepareFixture(url)
    console.log(`P21 ${mode} 隔离夹具：${fixture.root}`)
    try {
      const code=await superviseElectron({args:[fixture.output],cwd:desktop,
        env:{...fixture.env,HERMES_DESKTOP_SKIP_QUIT_CONFIRM:'0',FIXTURE_QUIT_TEST:mode}})
      const error=await readFile(path.join(fixture.root,'quit-error.txt'),'utf8').catch(()=>'')
      assert.equal(error,'')
      assert.equal(code,0)
      const saved=JSON.parse(await readFile(path.join(fixture.root,'quit-before.json'),'utf8'))
      assert.equal(saved.hiddenContinued,true)
      for (const pid of [saved.electron,saved.backend,saved.worker,...saved.work.map(row=>row.pid)]) {
        assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
      }
      await access(path.join(fixture.userData,'maas-login.enc'))
      await access(path.join(saved.home,'cron','jobs.json'))
      await access(path.join(saved.context.home,'state.db'))
      await assert.rejects(access(path.join(fixture.userData,'maas-logout-pending.json')),{code:'ENOENT'})
    } finally {
      await promisify(execFile)(process.env.FIXTURE_PYTHON || path.resolve(desktop,'../../.venv/Scripts/python.exe'),
        [path.join(desktop,'scripts/account-work.fixture.py'),'cleanup',fixture.root],
        {cwd:path.resolve(desktop,'../..'),windowsHide:true,timeout:20_000})
      await server.close()
    }
  })
}

for (const expiry of [false,true]) {
test(expiry ? 'P22 真实短期限：任务跨到期继续，手动退出有效，冷启动拒绝过期身份' :
  'P19/P20 真实开发监督进程：退出停止后端、消息网关与子树，重启到登录页', {timeout:420_000}, async () => {
  const {server,url} = await startLoginDevServer()
  const fixture = await prepareFixture(url)
  const unrelated = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true})
  console.log(`P19 隔离退出夹具：${fixture.root}`)
  try {
    const code = await superviseElectron({args:[fixture.output], cwd:desktop,
      env:{...fixture.env,FIXTURE_LOGOUT_TEST:'1',FIXTURE_NODE:process.execPath,FIXTURE_PLAN:'available',
        ...(expiry ? {FIXTURE_EXPIRY_TEST:'1',FIXTURE_EXPIRY_MS:'180000'} : {})}})
    const error = await readFile(path.join(fixture.root,'logout-error.txt'),'utf8').catch(() => '')
    assert.equal(error,'')
    assert.equal(code,0)
    const before = JSON.parse(await readFile(path.join(fixture.root,'logout-before.json'),'utf8'))
    const after = JSON.parse(await readFile(path.join(fixture.root,'logout-after.json'),'utf8'))
    assert.notEqual(before.electron,after.electron)
    assert.equal(after.login,true)
    assert.equal(unrelated.exitCode,null)
    assert.equal(unrelated.signalCode,null)
    for (const pid of [before.electron,before.backend,before.controlled,before.leaf]) {
      assert.throws(() => process.kill(pid,0),{code:'ESRCH'})
    }
    assert.ok(before.gateways.length>0)
    await gatewayOperation(before.context,'check')
    for (const gateway of before.gateways) assert.throws(() => process.kill(gateway.pid,0),{code:'ESRCH'})
    assert.equal(await readFile(path.join(before.context.workspace,'logout-history-sentinel.txt'),'utf8'),'preserve account files')
    await access(path.join(before.context.home,'state.db'))
    await assert.rejects(access(path.join(fixture.userData,'maas-login.enc')),{code:'ENOENT'})
    await assert.rejects(access(path.join(fixture.userData,'maas-logout-pending.json')),{code:'ENOENT'})
    if (expiry) {
      const continued=JSON.parse(await readFile(path.join(fixture.root,'expiry.json'),'utf8'))
      assert.equal(continued.continued,true)
      assert.equal(continued.originalExpiryKept,true)
      assert.equal(continued.notices,1)
      for (const pid of continued.pids) assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
      const encrypted=await readFile(path.join(fixture.root,'expiry-login.enc'))
      await writeFile(path.join(fixture.userData,'maas-login.enc'),encrypted)
      const cold=await electron.launch({executablePath:electronPath,args:[fixture.output],
        env:{...fixture.env,FIXTURE_LOGIN_DISABLE:'1'},timeout:45_000})
      try {
        const login=await cold.firstWindow()
        await login.getByRole('heading',{name:'登录 Hermes'}).waitFor({timeout:45_000})
        assert.equal(await cold.evaluate(()=>globalThis.fixtureContext()),null)
        assert.equal(await cold.evaluate(()=>globalThis.fixturePlanQueries),0)
        assert.deepEqual(await readFile(path.join(fixture.userData,'maas-login.enc')),encrypted)
      } finally {await cold.close()}
    }
    // 再次恢复同一测试身份，确认复用原账号；不是一次真实 MaaS 短信登录。
    const instance = await electron.launch({executablePath:electronPath,args:[fixture.output],
      env:{...fixture.env,...(expiry ? {FIXTURE_RELOGIN:'1'} : {})},timeout:45_000})
    try {
      await chatWindow(instance,[])
      assert.equal((await instance.evaluate(() => globalThis.fixtureContext())).id,before.context.id)
    } finally { await instance.close() }
  } finally {
    const snapshot=await readFile(path.join(fixture.root,'logout-gateway.json'),'utf8').catch(() => '')
    if (snapshot) {
      const {context,gateways}=JSON.parse(snapshot)
      await gatewayOperation(context,'stop',gateways)
    }
    if (unrelated.exitCode === null && unrelated.signalCode === null) { unrelated.kill(); await once(unrelated,'exit') }
    if (expiry) await promisify(execFile)(process.env.FIXTURE_PYTHON || path.resolve(desktop,'../../.venv/Scripts/python.exe'),
      [path.join(desktop,'scripts/account-work.fixture.py'),'cleanup',fixture.root],
      {cwd:path.resolve(desktop,'../..'),windowsHide:true,timeout:20_000})
    await server.close()
  }
})
}

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
      format:'cjs', external:['electron'], outfile:path.join(renderer,'dist',filename),
      // 仅夹具增加已执行标记；原版预览脚本和生产 preload 不变。
      footer:filename === 'preview-guest-preload.js' ?
        {js:"require('electron').ipcRenderer.sendToHost('fixture-preview-preload-ready')"} : undefined})
  }
  await build({stdin:{resolveDir:desktop, contents:`
    import {app, dialog, net, Tray} from 'electron'
    import {existsSync, writeFileSync} from 'node:fs'
    import {CredentialStore} from './electron/login/credential-store'
    import {accountBrowserPartition} from './electron/entry_local/browser-partition'
    globalThis.fixtureBrowserPartition = accountBrowserPartition
    app.setAppPath(${JSON.stringify(renderer)})
    // 夹具不修改 Windows URL 关联；产品使用独立的桌面开发版 scheme。
    globalThis.fixtureProtocols = []
    globalThis.fixtureErrors = []
    globalThis.fixturePreloadErrors = []
    globalThis.fixtureFailedPids = []
    globalThis.fixtureStopFault = process.env.FIXTURE_STOP_FAULT
    // 仅夹具模拟平台原期限已过；仍使用真实系统加密并保留原账号字段。
    globalThis.fixtureExpireLogin = () => {
      const store=new CredentialStore(app.getPath('userData'))
      store.save({...store.load(),expiresAt:Date.now()-1000})
    }
    const setContextMenu=Tray.prototype.setContextMenu
    Tray.prototype.setContextMenu=function(menu) {globalThis.fixtureTrayMenu=menu; return setContextMenu.call(this,menu)}
    app.on('web-contents-created', (_event, contents) => {
      contents.on('preload-error', (_event, filename, error) => globalThis.fixturePreloadErrors.push(error.stack))
    })
    dialog.showMessageBox = async (_window, options) => {
      options ??= _window
      globalThis.fixtureErrors.push(options.message)
      if(process.env.FIXTURE_EXIT_FAILURE==='1' && options.buttons?.[0]==='重试') {
        globalThis.fixtureLogoutDialogs ??= []
        globalThis.fixtureLogoutDialogs.push({message:options.message,detail:options.detail,buttons:options.buttons})
        writeFileSync(${JSON.stringify(path.join(root,'p24-prompts.json'))},JSON.stringify(globalThis.fixtureLogoutDialogs))
        return new Promise(resolve=>{globalThis.fixtureLogoutAnswer=resolve})
      }
      if(process.env.FIXTURE_HOLD_STARTUP_FAILURE==='1' && options.buttons?.length===1 && options.buttons[0]==='退出应用') {
        globalThis.fixtureStartupDialog={message:options.message,buttons:options.buttons}
        return new Promise(resolve=>{globalThis.fixtureStartupAnswer=resolve})
      }
      if (globalThis.fixtureLogoutError) writeFileSync(${JSON.stringify(path.join(root, 'logout-stage-error.txt'))},globalThis.fixtureLogoutError)
      return {response:globalThis.fixtureDialogResponse ?? 1, checkboxChecked:false}
    }
    if(process.env.FIXTURE_BLOCKED_START==='1') dialog.showErrorBox=(_title,message)=>{
      writeFileSync(${JSON.stringify(path.join(root,'blocked-start.json'))},JSON.stringify({message,
        windows:app.isReady() ? require('electron').BrowserWindow.getAllWindows().length : 0}))
    }
    app.setAsDefaultProtocolClient = scheme => {globalThis.fixtureProtocols.push(scheme); return false}
    const originalFetch = net.fetch
    globalThis.fixturePlanQueries = 0
    net.fetch = (...args) => String(args[0]).startsWith('https://maas.ai-yuanjing.com/') ?
      (String(args[0]).endsWith('/my-plan') && globalThis.fixturePlanQueries++,
      Promise.resolve(process.env.FIXTURE_PLAN === 'failed' ? new Response('',{status:503}) :
        process.env.FIXTURE_PLAN === 'rejected' ? new Response('',{status:401}) :
        process.env.FIXTURE_PLAN === 'available' ? Response.json({apiKey:'fixture-only-model-key',
          models:{models:[{id:'fixture',model:'fixture-desktop-model',base_url:'https://models.invalid/v1'}]}}) :
        Response.json({apiKey:null, models:null}))) : originalFetch(...args)
    // 真实系统加密，完整可信身份只在主进程，页面不传 UID 或 token。
    app.whenReady().then(() => {
      if (process.env.FIXTURE_LOGIN_DISABLE === '1') return
      if (process.env.FIXTURE_LOGOUT_TEST === '1' && existsSync(${JSON.stringify(path.join(root, 'logout-started'))})) return
      const store = new CredentialStore(app.getPath('userData'))
      const uid = process.env.FIXTURE_UID || 'fixture-desktop-account'
      if (store.load()?.uid !== uid || process.env.FIXTURE_RELOGIN === '1') store.save({
        namespace:'maas.ai-yuanjing.com/uniwork', uid,
        token:'fixture-login-token', maskedPhone:uid === 'fixture-desktop-account-b' ? '139****0000' : '138****0000',
        expiresAt:Date.now()+Number(process.env.FIXTURE_EXPIRY_MS || 600_000)
      })
    })
    await import('./electron/entry')
    const {currentDesktopLocalContext} = await import('./electron/login/bootstrap')
    globalThis.fixtureContext = () => currentDesktopLocalContext()
    globalThis.fixtureOpenDesktop = () => import('./electron/main').then(module => module.openAccountDesktop())
    globalThis.fixtureMain = () => import('./electron/main').then(module => module.fixtureNativeState)
    if (process.env.FIXTURE_LOGOUT_TEST === '1') {
      void import(${JSON.stringify(pathToFileURL(path.join(desktop, 'scripts', 'account-logout.fixture.mjs')).href)})
        .then(module => module.exerciseLogout(${JSON.stringify(root)}, ${JSON.stringify(userData)}))
        .catch(error => { writeFileSync(${JSON.stringify(path.join(root, 'logout-error.txt'))}, error.stack); app.exit(1) })
    }
    if (process.env.FIXTURE_QUIT_TEST) {
      void import(${JSON.stringify(pathToFileURL(path.join(desktop, 'scripts', 'account-quit.fixture.mjs')).href)})
        .then(module => module.exerciseQuit(${JSON.stringify(root)}, ${JSON.stringify(userData)}))
        .catch(error => {writeFileSync(${JSON.stringify(path.join(root,'quit-error.txt'))},error.stack); app.exit(1)})
    }
  `}, bundle:true, format:'esm', platform:'node', target:'node20',
  external:['electron','node-pty','get-windows'], outfile:output,
  define:{__HERMES_PRODUCT_IDENTITY__:JSON.stringify(createRequire(import.meta.url)(path.join(desktop,'product-identity.cjs')))},
  plugins:[{name:'observe-runtime-error', setup(builder) {
    // 故障只注入测试 bundle 的进程操作；归属表、最终存活检查与退出事务保持正式代码。
    builder.onLoad({filter:/entry_local[\\/]logout-processes\.ts$/}, async args => ({loader:'ts',
      contents:(await readFile(args.path,'utf8')).replace('execFileSync }','execFileSync as realExecFileSync }') + `
        /** 为真实隔离进程制造故障，不替换最终存活检查。 */
        function execFileSync(file,args,options) {
          const fault=globalThis.fixtureStopFault
          let command=args.at(-1)
          if(fault && command.includes('taskkill.exe')) {
            globalThis.fixtureFaultCalls=(globalThis.fixtureFaultCalls || 0)+1
            if(fault==='timeout') return realExecFileSync(file,['-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 5'],{...options,timeout:250})
            if(fault==='refused' || (fault==='residual' && Number(command.match(/ProcessId=(\\d+)/)?.[1])===globalThis.fixtureLeaf)) return ''
            if(fault==='residual') args=[...args.slice(0,-1),command.replace('/T /F','/F')]
          }
          const result=realExecFileSync(file,args,options)
          if(fault==='unknown' && command.includes('Select-Object')) {
            const rows=JSON.parse(result)
            for(const row of rows) if(row.pid===globalThis.fixtureRoot) row.started=''
            return JSON.stringify(rows)
          }
          return result
        }
      `,resolveDir:path.dirname(args.path)}))
    builder.onLoad({filter:/entry_local[\\/]desktop-runtime\.ts$/}, async args => ({loader:'ts',
      contents:(await readFile(args.path,'utf8')).replace("await import('../main')",
        "await import('../main').catch(error => {globalThis.fixtureImportError=error.stack; throw error})"),
      resolveDir:path.dirname(args.path)}))
    // 存储与归属使用正式代码；P23 仅在测试 bundle 注入失败进程参数和较短健康时限。
    builder.onLoad({filter:/electron[\\/]main\.ts$/}, async args => ({loader:'ts',
      contents:(await readFile(args.path,'utf8')).replace('await accountLogout.run(mode)',
        'await accountLogout.run(mode).catch(error => {globalThis.fixtureLogoutError=error.stack; throw error})')
        .replace('function spawnOwnedBackend(...args: Parameters<typeof spawn>): ChildProcess {',
          "function spawnOwnedBackend(...args: Parameters<typeof spawn>): ChildProcess { if(['exit','health'].includes(process.env.FIXTURE_FAIL_BACKEND) && args[1]?.includes('serve')) {args[1]=['-c',process.env.FIXTURE_FAIL_BACKEND==='exit'?'import sys; sys.exit(9)':\"import os,time; print('HERMES_BACKEND_READY port='+os.environ['FIXTURE_HEALTH_PORT'],flush=True); time.sleep(600)\"]}")
        .replace('const child = localBackendLifecycle.spawn((): ChildProcess => spawn(...args))',
          'const child = localBackendLifecycle.spawn((): ChildProcess => spawn(...args)); if(process.env.FIXTURE_FAIL_BACKEND) globalThis.fixtureFailedPids.push(child.pid)')
        .replace('return waitForHermesReady(baseUrl, {',
          "return waitForHermesReady(baseUrl, { timeoutMs: process.env.FIXTURE_FAIL_BACKEND==='health'?1500:undefined,") + `
        export const fixtureNativeState = {paths:ACCOUNT_DESKTOP_STATE,
          startBackend:startHermes,
          tray:minimizeToTray,
          spawnFixtureBackend:spawnOwnedBackend,
          claimFixtureBackend:claimBackendChild,
          logoutAccount:logoutDesktopAccount,
          browserSession:ACCOUNT_SESSION, rendererPartition:ACCOUNT_RENDERER_PARTITION,
          oauthSession:getOauthSessionForUrl, warmCookies:warmOauthCookieStore,
          windows:{peer:createInstanceWindow,secondary:spawnSecondaryWindow,browser:spawnBrowserWindow,
            hud:spawnHudWindow,quick:spawnQuickEntryWindow,pet:spawnPetOverlayWindow},
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
  if (process.env.FIXTURE_PYTHON) env.HERMES_DESKTOP_PYTHON=process.env.FIXTURE_PYTHON
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

/** 在真正页面中读写同一 Cookie、localStorage 和 IndexedDB 键，不使用存储替身。 */
async function browserStore({id,first}) {
  const before = localStorage.getItem('fixture-account-owner')
  const cookiesBefore = document.cookie
  const database = await new Promise((resolve,reject) => {
    const request = indexedDB.open('fixture-account-state',1)
    request.onupgradeneeded = () => request.result.createObjectStore('owners')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error(`夹具 IndexedDB 打开失败：${request.error?.name} ${request.error?.message}`))
  })
  const indexedBefore = await new Promise((resolve,reject) => {
    const request = database.transaction('owners').objectStore('owners').get('same-key')
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => reject(new Error('夹具 IndexedDB 读取失败'))
  })
  if (first) {
    localStorage.setItem('fixture-account-owner',id)
    document.cookie = `fixture_owner=${id}; Path=/; Max-Age=600`
    await new Promise((resolve,reject) => {
      const transaction = database.transaction('owners','readwrite')
      transaction.objectStore('owners').put(id,'same-key')
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(new Error('夹具 IndexedDB 写入失败'))
    })
  }
  database.close()
  return {before,indexedBefore,cookiesBefore,after:localStorage.getItem('fixture-account-owner')}
}

/** 同账号重新打开可读回原值；不同账号和不同用途的首次页面必须为空。 */
function assertBrowserStore(result,id,first) {
  assert.equal(result.before,first ? null : id)
  assert.equal(result.indexedBefore,first ? null : id)
  assert.equal(result.after,id)
  assert.equal(result.cookiesBefore.includes('fixture_owner='),!first)
  assert.equal(result.cookiesBefore.includes('fixture_global='),false)
  if (!first) assert.ok(result.cookiesBefore.includes(`fixture_owner=${id}`))
}

/** 验证原生分区、实际 webview 附着、原版远程 Cookie 和媒体协议仍在账号内。 */
async function verifyBrowserIsolation(instance,page,context,first) {
  const browser = await instance.evaluate(async (_electron,{first,id,url}) => {
    const main = await globalThis.fixtureMain()
    const jar = main.oauthSession('https://fixture.invalid')
    await main.warmCookies('https://fixture.invalid')
    const cookies = await jar.cookies.get({url:'https://fixture.invalid',name:'fixture_owner'})
    if (first) await jar.cookies.set({url:'https://fixture.invalid',name:'fixture_owner',value:id,
      expirationDate:Date.now()/1000+600})
    await jar.cookies.flushStore()
    main.browserSession.flushStorageData()
    return {partition:main.rendererPartition,storage:main.browserSession.storagePath,
      oauthStorage:jar.storagePath,cookie: cookies[0]?.value ?? null,
      expectedPartition:globalThis.fixtureBrowserPartition({id},'persist:desktop'),
      media:await main.browserSession.protocol.isProtocolHandled('hermes-media')}
  },{first,id:context.id,url:page.url()})
  assert.equal(browser.cookie,first ? null : context.id)
  assert.equal(browser.media,true)
  assert.equal(browser.partition,browser.expectedPartition)
  assert.notEqual(browser.storage,browser.oauthStorage)
  assertBrowserStore(await page.evaluate(browserStore,{id:context.id,first}),context.id,first)
  const mediaPath = path.join(context.workspace,'p17-fixture-media.wav')
  // 最小无声 PCM，走原版媒体元素而不是不被 CORS 允许的跨源 fetch。
  const wave = Buffer.alloc(48)
  wave.write('RIFF',0); wave.writeUInt32LE(40,4); wave.write('WAVEfmt ',8)
  wave.writeUInt32LE(16,16); wave.writeUInt16LE(1,20); wave.writeUInt16LE(1,22)
  wave.writeUInt32LE(8000,24); wave.writeUInt32LE(16000,28)
  wave.writeUInt16LE(2,32); wave.writeUInt16LE(16,34)
  wave.write('data',36); wave.writeUInt32LE(4,40)
  await writeFile(mediaPath,wave)
  const mediaUri = `hermes-media://stream/${encodeURIComponent(mediaPath)}`
  const metadata = await page.evaluate(uri => new Promise((resolve,reject) => {
    const audio = new Audio(uri)
    const timer = setTimeout(() => reject(new Error('夹具媒体未加载')),10_000)
    audio.onloadedmetadata = () => {clearTimeout(timer);resolve({duration:audio.duration})}
    audio.onerror = () => {clearTimeout(timer);reject(new Error('夹具媒体加载失败：'+audio.error?.code))}
    audio.load()
  }),mediaUri)
  assert.ok(metadata.duration > 0)
  const bytes = await instance.evaluate(async (_electron,uri) => {
    const response = await (await globalThis.fixtureMain()).browserSession.fetch(uri)
    return [...new Uint8Array(await response.arrayBuffer())]
  },mediaUri)
  assert.deepEqual(bytes,[...wave])
  // 原版标签声明保持不变，观察主进程在首次附着前选择的真实 Session。
  await page.evaluate(async url => {
    const guest = document.createElement('webview')
    guest.id = 'p17-preview'
    guest.setAttribute('partition','persist:hermes-preview')
    guest.style.cssText = 'position:fixed;left:-10000px;width:20px;height:20px'
    guest.addEventListener('ipc-message',event => {
      if (event.channel === 'fixture-preview-preload-ready') guest.dataset.fixturePreloadReady = 'true'
    })
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('夹具预览没有就绪')),15_000)
      guest.addEventListener('dom-ready',() => {clearTimeout(timer);resolve()},{once:true})
      guest.src = new URL('/login.html',url).href
      document.body.append(guest)
    })
  },page.url())
  await page.waitForFunction(() => document.getElementById('p17-preview')?.dataset.fixturePreloadReady === 'true',
    null,{polling:100,timeout:15_000})
  const preview = await instance.evaluate(async ({webContents,session}, {script,args}) => {
    const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview')
    const preferences = guest.getLastWebPreferences()
    const result = await guest.executeJavaScript(`(${script})(${JSON.stringify(args)})`)
    guest.session.flushStorageData()
    await guest.session.cookies.flushStore()
    const expectedPartition = globalThis.fixtureBrowserPartition({id:args.id},'persist:hermes-preview')
    return {result,storage:guest.session.storagePath,
      correctSession:guest.session === session.fromPartition(expectedPartition),
      node:preferences.nodeIntegration,sandbox:preferences.sandbox}
  },{script:browserStore.toString(),args:{id:context.id,first}})
  assertBrowserStore(preview.result,context.id,first)
  assert.notEqual(preview.storage,browser.storage)
  assert.notEqual(preview.storage,browser.oauthStorage)
  assert.equal(preview.correctSession,true)
  assert.equal(preview.node,false)
  assert.equal(preview.sandbox,true)
  await page.evaluate(() => document.getElementById('p17-preview').remove())
  const download = await instance.evaluate(async ({app,BrowserWindow}) => {
    const main = await globalThis.fixtureMain()
    const result = await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('夹具下载事件未触发')),10_000)
      main.browserSession.once('will-download',(event,item) => {
        event.preventDefault()
        clearTimeout(timer)
        resolve(item.getSaveDialogOptions())
      })
      BrowserWindow.getAllWindows().find(window => window.webContents.session === main.browserSession)
        .webContents.downloadURL('data:text/plain,fixture-account-download')
    })
    return {result,downloads:app.getPath('downloads')}
  })
  assert.equal(download.result.title,'Save File')
  assert.equal(path.dirname(download.result.defaultPath),download.downloads)
  return browser
}

/** 使用原版窗口创建函数核对归属，并在实际同源副窗读取主窗存储。 */
async function verifyAccountWindows(instance,page,id) {
  const peers = await instance.evaluate(async () => {
    const main = await globalThis.fixtureMain()
    const windows = [main.windows.peer(),main.windows.secondary({watch:true}),
      main.windows.browser('fixture-preview'),main.windows.hud(null,null),
      main.windows.quick(),main.windows.pet({})]
    const result = windows.map(window => ({id:window.webContents.id,
      sameSession:window.webContents.session === main.browserSession,
      partition:window.webContents.getLastWebPreferences().partition}))
    // 除完整副窗外，只检验真实构造接线；不让辅助窗口参与用户桌面。
    for (const window of windows.slice(1)) window.destroy()
    return result
  })
  assert.equal(peers.every(peer => peer.sameSession),true)
  const peer = instance.windows().find(window => window.url().includes('peer=1')) ??
    await instance.waitForEvent('window', {predicate:window => window.url().includes('peer=1'),timeout:30_000})
  assert.ok(peer)
  await peer.waitForLoadState('domcontentloaded')
  assert.equal(await peer.evaluate(() => localStorage.getItem('fixture-account-owner')),id)
  assert.deepEqual(await peer.evaluate(() => window.hermesDesktop.getMaasAccount()),
    await page.evaluate(() => window.hermesDesktop.getMaasAccount()))
  await verifyAccountBadge(peer, '138****0000')
  await page.evaluate(async () => {
    const store = await import('/src/store/composer.ts')
    store.stashSessionDraft('fixture-same-session','fixture-same-account-draft',[])
  })
  await peer.waitForFunction(() => localStorage.getItem('hermes:composer-drafts:v3')
    ?.includes('fixture-same-account-draft'),null,{polling:100})
  await instance.evaluate(({webContents},id) => webContents.fromId(id).close(),peers[0].id)
}

/** 检查账号在右下角完整可见，只有脱敏文本，没有菜单或退出动作。 */
async function verifyAccountBadge(page, phone) {
  const badge = page.locator('[data-slot="statusbar"]').getByText(phone, {exact:true})
  await badge.waitFor({timeout:60_000})
  const geometry = await badge.evaluate(element => {
    const box = element.getBoundingClientRect()
    return {right:box.right, left:box.left, bottom:box.bottom, width:innerWidth, height:innerHeight,
      interactive:!!element.closest('button,a'), clipped:element.scrollWidth > element.clientWidth}
  })
  assert.equal(geometry.interactive,false)
  assert.equal(geometry.clipped,false)
  assert.ok(geometry.left > geometry.width / 2 && geometry.right <= geometry.width)
  assert.ok(geometry.bottom > geometry.height - 40)
}

/** 让真实 HTTP 响应晚于旧窗销毁，确认新的独立分区不会收到旧页面写入。 */
async function verifyLateWindowIsolation(instance) {
  let releaseResponse
  let signalStarted
  let signalEnded
  const started = new Promise(resolve => {signalStarted = resolve})
  const ended = new Promise(resolve => {signalEnded = resolve})
  const server = createServer((request,response) => {
    if (request.url === '/late') {
      response.once('close',signalEnded)
      releaseResponse = () => response.end('delayed-old-account')
      signalStarted()
    } else {
      response.setHeader('Content-Type','text/html')
      response.end('<!doctype html><title>isolated storage probe</title>')
    }
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    await instance.evaluate(async ({BrowserWindow},url) => {
      const main = await globalThis.fixtureMain()
      const window = new BrowserWindow({show:false,webPreferences:{partition:main.rendererPartition}})
      globalThis.fixtureLateWindow = window
      await window.loadURL(url)
      void window.webContents.executeJavaScript(
        "fetch('/late').then(() => localStorage.setItem('fixture-late-owner','old-account'))").catch(() => {})
    },url)
    await started
    await instance.evaluate(async ({BrowserWindow},url) => {
      globalThis.fixtureLateWindow.destroy()
      const partition = globalThis.fixtureBrowserPartition({id:'fixture-delayed-other-account'},'persist:desktop')
      const window = new BrowserWindow({show:false,webPreferences:{partition}})
      globalThis.fixtureNextWindow = window
      await window.loadURL(url)
    },url)
    releaseResponse()
    await ended
    const result = await instance.evaluate(async () => ({
      oldDestroyed:globalThis.fixtureLateWindow.isDestroyed(),
      nextValue:await globalThis.fixtureNextWindow.webContents.executeJavaScript(
        "localStorage.getItem('fixture-late-owner')")
    }))
    assert.deepEqual(result,{oldDestroyed:true,nextValue:null})
  } finally {
    releaseResponse?.()
    await instance.evaluate(() => {
      for (const window of [globalThis.fixtureLateWindow,globalThis.fixtureNextWindow]) {
        if (window && !window.isDestroyed()) window.destroy()
      }
    })
    await new Promise(resolve => server.close(resolve))
  }
}

test('P15～P17 原生 Electron：自动进入账号桌面，REST/WS 与 A→B→A Chromium/桌面存储隔离',
  {timeout:480_000}, async () => {
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
      // 在未归属账号的旧默认分区放哨兵；正式账号不得认领，测试也不删除它。
      await instance.evaluate(async ({session,BrowserWindow},url) => {
        await session.defaultSession.cookies.set({url,name:'fixture_global',value:'old-global',
          expirationDate:Date.now()/1000+600})
        const window = new BrowserWindow({show:false})
        await window.loadURL(new URL('/login.html',url).href)
        await window.webContents.executeJavaScript("localStorage.setItem('fixture-account-owner','old-global')")
        session.defaultSession.flushStorageData()
        await session.defaultSession.cookies.flushStore()
        window.destroy()
      },url)
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
        const first = scenario === 'empty' || scenario === 'account-b'
        await verifyBrowserIsolation(instance,page,context,first)
        if (scenario === 'available' || scenario === 'account-b' || scenario === 'account-a-return') {
          const editor = page.locator('textarea,[contenteditable="true"]').first()
          const skip = page.getByText('稍后再选择提供方',{exact:true})
          await Promise.race([editor.waitFor({timeout:60_000}),skip.waitFor({timeout:60_000})])
          if (await skip.isVisible()) await skip.click()
          await editor.waitFor({timeout:60_000})
          if (scenario === 'account-b') {
            assert.equal(await page.evaluate(() => localStorage.getItem('hermes:composer-drafts:v3')),null)
          } else if (scenario === 'account-a-return') {
            await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea,[contenteditable="true"]'))
              .some(element => (element.value ?? element.textContent)?.includes('fixture-unsent-A')),
              null,{polling:100,timeout:30_000})
          }
          await editor.fill(scenario === 'account-b' ? 'fixture-unsent-B' : 'fixture-unsent-A')
          await page.waitForFunction(text => localStorage.getItem('hermes:composer-drafts:v3')?.includes(text),
            scenario === 'account-b' ? 'fixture-unsent-B' : 'fixture-unsent-A',{polling:100})
          if (scenario === 'available') {
            await verifyAccountWindows(instance,page,context.id)
            await verifyLateWindowIsolation(instance)
          }
          const account = await page.evaluate(() => window.hermesDesktop.getMaasAccount())
          assert.deepEqual(Object.keys(account).sort(), ['expiresAt','maskedPhone'])
          assert.equal(account.maskedPhone, scenario === 'account-b' ? '139****0000' : '138****0000')
          await verifyAccountBadge(page, account.maskedPhone)
          if (scenario === 'available') {
            const original = await instance.evaluate(({BrowserWindow}) => {
              const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http'))
              const size = window.getSize()
              window.setSize(640,600)
              return size
            })
            await verifyAccountBadge(page, account.maskedPhone)
            await page.screenshot({path:path.join(fixture.root,'account-badge-narrow.png')})
            await instance.evaluate(({BrowserWindow},size) => {
              BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http')).setSize(...size)
            }, original)
          }
        }
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
        if (scenario === 'account-a-return') {
          const old = await instance.evaluate(async ({session,BrowserWindow},url) => {
            const cookies = await session.defaultSession.cookies.get({url,name:'fixture_global'})
            const window = new BrowserWindow({show:false})
            await window.loadURL(new URL('/login.html',url).href)
            const owner = await window.webContents.executeJavaScript("localStorage.getItem('fixture-account-owner')")
            window.destroy()
            return {owner,cookie:cookies[0]?.value}
          },url)
          assert.deepEqual(old,{owner:'old-global',cookie:'old-global'})
        }
        await instance.close()
        instance = null
        // 只检查该夹具账本中的进程，不停止或枚举全机 Hermes。
        assert.throws(() => process.kill(ledger.pid,0), {code:'ESRCH'})
      }
      assert.equal(await readFile(path.join(fixture.userData,'connection.json'),'utf8'),'{"mode":"remote","url":"http://127.0.0.1:1"}')
      for (const [name,content] of Object.entries(fixture.globalSentinels)) {
        assert.equal(await readFile(path.join(fixture.userData,name),'utf8'),content)
      }
      console.log(`P15～P17 原版桌面真实链路验收目录：${fixture.root}`)
    } finally {
      await instance?.close()
      await server.close()
    }
  })
