import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {access, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {pathToFileURL} from 'node:url'

import {_electron as electron} from '@playwright/test'
import electronPath from 'electron'
import {build} from 'esbuild'

import {startFixtureGateway, cleanupFixtureGateways} from './gateway-logout.fixture.mjs'

/** 等待本轮窗口或文件事实，测试失败时不无限轮询。 */
async function until(read,label) {
  const deadline=Date.now()+120_000
  while(Date.now()<deadline) {
    const value=await read()
    if(value) return value
    await delay(100)
  }
  throw new Error(`P25 夹具超时：${label}`)
}

/** 只观察夹具持有的 PID，不按名称查杀用户进程。 */
function alive(pid) {
  try {process.kill(pid,0);return true}
  catch(error) {if(error.code==='ESRCH') return false;throw error}
}

/** 强制结束独立 Electron，重开沿用真实登录、归属文件与原版后端。 */
export async function exerciseAccountRecovery(fixture,mode) {
  const toolsFile=path.join(fixture.root,'process-tools.mjs')
  await build({entryPoints:[path.resolve(import.meta.dirname,'../electron/entry_local/logout-processes.ts')],
    bundle:true,platform:'node',format:'esm',outfile:toolsFile})
  const tools=await import(pathToFileURL(toolsFile).href)
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true})
  let instance,owned=[],appTree=[]
  try {
    instance=await electron.launch({executablePath:electronPath,args:[fixture.output],
      env:{...fixture.env,FIXTURE_PLAN:'available',FIXTURE_EXIT_FAILURE:'1',FIXTURE_BLOCKED_START:'1'},timeout:45_000})
    let page=await until(()=>instance.windows().find(p=>p.url().startsWith('http') && !p.url().includes('login.html')),'初次桌面')
    await page.waitForFunction(()=>typeof window.hermesDesktop?.getConnection==='function',null,{polling:100,timeout:90_000})
    const firstConnection=await page.evaluate(()=>window.hermesDesktop.getConnection())
    const context=await instance.evaluate(()=>globalThis.fixtureContext())
    const intentFile=path.join(fixture.userData,'maas-logout-pending.json')
    const credentialFile=path.join(fixture.userData,'maas-login.enc')
    const ownershipFile=path.join(context.desktopState,'backend-ownership.json')
    const sentinel=path.join(context.workspace,'p25-history-file.txt')
    await writeFile(sentinel,'keep account file')
    assert.deepEqual(JSON.parse(await readFile(intentFile,'utf8')),{account:context.id,mode:'quit'})

    // 使用正式 claim 记录独立父子进程；分离后可真实跨越 Electron 崩溃存活。
    const leafFile=path.join(fixture.root,'p25-leaf.json')
    const script=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});require('node:fs').writeFileSync(${JSON.stringify(leafFile)},JSON.stringify({pid:child.pid}));setInterval(()=>{},1000)`
    const root=await instance.evaluate(async(_electron,{node,script})=>{
      const state=await globalThis.fixtureMain()
      const child=state.spawnFixtureBackend(node,['-e',script],{detached:true,stdio:'ignore',windowsHide:true})
      await state.claimFixtureBackend(child,node,'default','fixture-recovery-root')
      return child.pid
    },{node:process.execPath,script})
    const leaf=await until(()=>readFile(leafFile,'utf8').then(text=>JSON.parse(text).pid).catch(error=>{
      if(error.code==='ENOENT') return null;throw error
    }),'持有的子进程')
    const ownership=JSON.parse(await readFile(ownershipFile,'utf8'))
    owned=tools.logoutProcessTree(tools.listLogoutProcesses(),ownership.backends.map(row=>row.pid).filter(alive))
    const mainPid=await instance.evaluate(()=>process.pid)
    appTree=tools.logoutProcessTree(tools.listLogoutProcesses(),[mainPid])
    const appIdentity=appTree.find(row=>row.pid===mainPid)
    assert.ok(owned.some(row=>row.pid===leaf))
    let gateway
    if(mode==='running') {
      // 真实无关 PID 配旧创建时间模拟 PID 复用；恢复必须保留该进程。
      ownership.backends.push({...ownership.backends[0],pid:unrelated.pid,startMarker:'win:1',nonce:'fixture-reused-pid'})
      await writeFile(ownershipFile,JSON.stringify(ownership))
      const peer=spawn(electronPath,[fixture.output],{env:{...fixture.env,FIXTURE_LOGIN_DISABLE:'1'},stdio:'ignore',windowsHide:true})
      try {assert.equal((await once(peer,'exit',{signal:AbortSignal.timeout(30_000)}))[0],0)}
      finally {if(peer.exitCode===null && peer.signalCode===null) peer.kill()}
      assert.equal(alive(root),true)
      assert.equal(alive(leaf),true)
      gateway=await startFixtureGateway(context,context.home)
    }
    if(mode==='expired') await instance.evaluate(()=>globalThis.fixtureExpireLogin())
    const encrypted=await readFile(credentialFile)

    if(mode==='logout') {
      await instance.evaluate(()=>{
        globalThis.fixtureStopFault='refused'
        void globalThis.fixtureMain().then(state=>state.logoutAccount('logout'))
      })
      await until(()=>readFile(path.join(fixture.root,'p24-prompts.json'),'utf8').then(text=>JSON.parse(text).length).catch(error=>{
        if(error.code==='ENOENT') return null;throw error
      }),'退出中保留停止意图')
      const saved=JSON.parse(await readFile(intentFile,'utf8'))
      assert.equal(saved.mode,'logout')
      assert.ok(saved.processes.some(row=>row.pid===leaf))
    }

    const crashed=once(instance.process(),'exit')
    assert.ok(tools.listLogoutProcesses().some(row=>row.pid===mainPid && row.started===appIdentity.started))
    process.kill(mainPid)
    await crashed
    instance=null
    assert.equal(alive(root),true)
    assert.equal(alive(leaf),true)
    if(gateway) assert.equal(alive(gateway.child.pid),true)
    console.log(`P25 ${mode}：已结束测试 Electron，旧子树仍存活`)

    instance=await electron.launch({executablePath:electronPath,args:[fixture.output],
      env:{...fixture.env,FIXTURE_PLAN:'available',FIXTURE_LOGIN_DISABLE:'1',FIXTURE_BLOCKED_START:'1'},timeout:45_000})
    page=await until(()=>instance.windows().find(p=>p.url().startsWith('http') &&
      (mode==='running' ? !p.url().includes('login.html') : p.url().includes('login.html'))),'恢复后的目标页面')
    assert.equal(alive(root),false)
    assert.equal(alive(leaf),false)
    if(gateway) await until(()=>!alive(gateway.child.pid),'独立网关已结束')
    assert.equal(alive(unrelated.pid),true)
    assert.equal(await readFile(sentinel,'utf8'),'keep account file')
    await access(path.join(context.home,'state.db'))
    assert.deepEqual(await instance.evaluate(()=>globalThis.fixtureErrors),[])

    if(mode==='running') {
      await page.waitForFunction(()=>typeof window.hermesDesktop?.getConnection==='function',null,{polling:100,timeout:90_000})
      const connections=await page.evaluate(()=>Promise.all(Array.from({length:3},()=>window.hermesDesktop.getConnection())))
      assert.ok(connections.every(connection=>connection.baseUrl===connections[0].baseUrl))
      assert.equal((await instance.evaluate(()=>globalThis.fixtureContext())).id,context.id)
      const current=JSON.parse(await readFile(ownershipFile,'utf8')).backends
      assert.equal(current.length,1)
      assert.ok(current.every(row=>!ownership.backends.some(old=>old.pid===row.pid && old.startMarker===row.startMarker)))
      assert.deepEqual(await readFile(credentialFile),encrypted)
      assert.ok(firstConnection.baseUrl)
      await page.locator('[data-slot=statusbar]').getByText('138****0000',{exact:true}).waitFor({timeout:90_000})
    } else {
      await page.waitForFunction(()=>typeof window.hermesLogin?.restore==='function',null,{polling:100,timeout:30_000})
      assert.equal(await instance.evaluate(()=>globalThis.fixtureContext()),null)
      assert.equal(await instance.evaluate(()=>globalThis.fixturePlanQueries),0)
      assert.deepEqual(JSON.parse(await readFile(ownershipFile,'utf8')).backends,[])
      await assert.rejects(access(intentFile),{code:'ENOENT'})
      if(mode==='logout') await assert.rejects(access(credentialFile),{code:'ENOENT'})
      else assert.deepEqual(await readFile(credentialFile),encrypted)
    }
    await page.screenshot({path:path.join(fixture.root,'p25-reopened.png')})
    const exited=once(instance.process(),'exit')
    await instance.evaluate(({app})=>app.quit())
    assert.equal((await exited)[0],0)
    instance=null
    await assert.rejects(access(intentFile),{code:'ENOENT'})
  } catch(error) {
    console.error(error)
    throw error
  } finally {
    await instance?.evaluate(()=>{globalThis.fixtureStopFault=null;globalThis.fixtureLogoutAnswer?.({response:0,checkboxChecked:false})}).catch(()=>{})
    await instance?.close().catch(()=>{})
    try {tools.stopLogoutProcesses([...owned,...appTree]);await cleanupFixtureGateways()}
    finally {if(alive(unrelated.pid)) {const closed=once(unrelated,'exit');unrelated.kill();await closed}}
  }
}
