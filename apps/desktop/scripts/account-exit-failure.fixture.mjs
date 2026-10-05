import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {access,readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'

import {_electron as electron} from '@playwright/test'
import electronPath from 'electron'
import {build} from 'esbuild'

/** 有限等待本轮应用的真实条件，不读取或控制用户现有窗口。 */
async function until(read,label) {
  const deadline=Date.now()+90_000
  while(Date.now()<deadline) {
    const result=await read()
    if(result) return result
    await delay(100)
  }
  throw new Error(`P24 夹具超时：${label}`)
}

/** 只以持有的测试 PID 检查存活，不查找同名 Hermes 或 Python。 */
function alive(pid) {
  try {process.kill(pid,0);return true}
  catch(error) {if(error.code==='ESRCH') return false;throw error}
}

/** 用原版退出入口与真实 Windows 子树验证故障、人工重试和保留记录。 */
export async function exerciseExitFailure(fixture,closeFailure) {
  const toolsFile=path.join(fixture.root,'process-tools.mjs')
  await build({entryPoints:[path.resolve(import.meta.dirname,'../electron/entry_local/logout-processes.ts')],
    bundle:true,platform:'node',format:'esm',outfile:toolsFile})
  const tools=await import(pathToFileURL(toolsFile).href)
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true})
  let instance,owned=[]
  try {
    instance=await electron.launch({executablePath:electronPath,args:[fixture.output],
      env:{...fixture.env,FIXTURE_PLAN:'available',FIXTURE_EXIT_FAILURE:'1'},timeout:45_000})
    const page=await until(()=>instance.windows().find(p=>p.url().startsWith('http') && !p.url().includes('login.html')),'桌面窗口')
    await page.waitForFunction(()=>typeof window.hermesDesktop?.getConnection==='function',null,{polling:100,timeout:90_000})
    await page.evaluate(()=>window.hermesDesktop.getConnection())
    const context=await instance.evaluate(()=>globalThis.fixtureContext())
    const encrypted=await readFile(path.join(fixture.userData,'maas-login.enc'))
    const marker=path.join(context.workspace,'p24-files-sentinel.txt')
    await writeFile(marker,'preserve account files')
    const leafFile=path.join(fixture.root,'leaf.json')
    const script=`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(leafFile)},JSON.stringify({pid:child.pid}));setInterval(()=>{},1000)`
    const root=await instance.evaluate(async(_electron,{node,script})=>{
      const state=await globalThis.fixtureMain()
      const child=state.spawnFixtureBackend(node,['-e',script],{detached:true,stdio:'ignore',windowsHide:true})
      globalThis.fixtureRoot=child.pid
      return child.pid
    },{node:process.execPath,script})
    const leaf=await until(()=>readFile(leafFile,'utf8').then(row=>JSON.parse(row).pid).catch(error=>{
      if(error.code==='ENOENT') return null;throw error
    }),'真实子进程')
    await instance.evaluate((_electron,pid)=>{globalThis.fixtureLeaf=pid},leaf)
    const ownershipFile=path.join(context.desktopState,'backend-ownership.json')
    const ownership=await readFile(ownershipFile)
    owned=tools.logoutProcessTree(tools.listLogoutProcesses(),[root,...JSON.parse(ownership).backends.map(row=>row.pid).filter(alive)])
    const intentFile=path.join(fixture.userData,'maas-logout-pending.json')
    const faults=closeFailure ? ['refused'] : ['unknown','timeout','refused','residual']
    let previous
    for(const [index,fault] of faults.entries()) {
      console.log(`P24 验证：${fault}${closeFailure ? ' 后关闭' : ''}`)
      await instance.evaluate((_electron,fault)=>{globalThis.fixtureStopFault=fault},fault)
      // 先让测试请求返回，再触发可能销毁窗口的退出流程。
      if(index===0) await instance.evaluate(({app})=>{setImmediate(()=>app.quit())})
      else await instance.evaluate(()=>globalThis.fixtureLogoutAnswer({response:0,checkboxChecked:false}))
      // 主进程同步查询进程时会阻塞调试通道，观察原生对话框捕获文件而不改变停止流程。
      const prompt=await until(()=>readFile(path.join(fixture.root,'p24-prompts.json'),'utf8').then(text=>{
        const prompts=JSON.parse(text)
        return prompts.length===index+1 ? prompts.at(-1) : null
      }).catch(error=>{if(error.code==='ENOENT') return null;throw error}),`失败提示 ${fault}`)
      await until(()=>instance.windows().find(window=>window.url().startsWith('data:')),'等待窗加载完成')
      assert.deepEqual(prompt.buttons,['重试','关闭应用'])
      assert.ok(prompt.message.includes('禁止切换账号'))
      assert.equal(/fixture-login-token|fixture-only-model-key|Traceback|powershell|ProcessId/.test(prompt.message+prompt.detail),false)
      const saved=JSON.parse(await readFile(intentFile,'utf8'))
      assert.equal(saved.account,context.id)
      assert.equal(saved.mode,'quit')
      if(fault!=='unknown') {
        assert.ok(saved.processes.some(row=>row.pid===leaf))
        assert.ok(saved.processes.some(row=>row.pid===root))
        if(previous) assert.deepEqual(saved.processes,previous)
        previous=saved.processes
      }
      assert.equal(alive(leaf),true)
      assert.equal(alive(root),fault!=='residual')
      assert.equal(alive(unrelated.pid),true)
      assert.deepEqual(await readFile(ownershipFile),ownership)
      assert.deepEqual(await readFile(path.join(fixture.userData,'maas-login.enc')),encrypted)
      const fenced=await instance.evaluate(async({app,BrowserWindow})=>{
        const state=await globalThis.fixtureMain()
        const window=BrowserWindow.getAllWindows()[0]
        const extra=new BrowserWindow({show:false})
        await Promise.resolve()
        app.quit()
        return {account:globalThis.fixtureContext(),extraDestroyed:extra.isDestroyed(),
          windows:BrowserWindow.getAllWindows().map(w=>w.webContents.getURL()),
          bridge:await window.webContents.executeJavaScript('typeof window.hermesDesktop'),
          blocked:await state.startBackend().then(()=>false,()=>true)}
      })
      assert.equal(fenced.account,null)
      assert.equal(fenced.extraDestroyed,true)
      assert.equal(fenced.bridge,'undefined')
      assert.equal(fenced.blocked,true)
      assert.equal(fenced.windows.length,1)
      assert.ok(fenced.windows[0].startsWith('data:'))
      assert.equal(await instance.evaluate(()=>globalThis.fixtureLogoutDialogs.length),index+1)
    }
    await instance.windows()[0].screenshot({path:path.join(fixture.root,'p24-exit-wait.png')})
    const exited=once(instance.process(),'exit')
    await instance.evaluate((_electron,closeFailure)=>{
      if(!closeFailure) globalThis.fixtureStopFault=null
      globalThis.fixtureLogoutAnswer({response:closeFailure ? 1 : 0,checkboxChecked:false})
    },closeFailure)
    assert.equal((await exited)[0],closeFailure ? 1 : 0)
    instance=null
    assert.equal(await readFile(marker,'utf8'),'preserve account files')
    await access(path.join(context.home,'state.db'))
    assert.deepEqual(await readFile(path.join(fixture.userData,'maas-login.enc')),encrypted)
    if(closeFailure) {
      assert.ok(alive(leaf))
      const pending=await readFile(intentFile)
      const cold=spawn(electronPath,[fixture.output],{env:{...fixture.env,FIXTURE_BLOCKED_START:'1',FIXTURE_LOGIN_DISABLE:'1',FIXTURE_STOP_FAULT:'refused'},stdio:'ignore',windowsHide:false})
      assert.equal((await once(cold,'exit'))[0],0)
      const report=JSON.parse(await readFile(path.join(fixture.root,'blocked-start.json'),'utf8'))
      assert.ok(report.message.includes('阻止恢复登录'))
      assert.equal(report.windows,0)
      assert.deepEqual(await readFile(intentFile),pending)
      assert.deepEqual(await readFile(ownershipFile),ownership)
    } else {
      assert.equal(alive(leaf),false)
      assert.equal(alive(root),false)
      await assert.rejects(access(intentFile),{code:'ENOENT'})
      assert.deepEqual(JSON.parse(await readFile(ownershipFile,'utf8')).backends,[])
    }
    assert.equal(alive(unrelated.pid),true)
  } catch(error) {
    console.error(error)
    throw error
  } finally {
    // 收尾使用未注入故障的正式停止函数和此前确认的创建时间，避免测试失败遗留进程。
    await instance?.evaluate(()=>{globalThis.fixtureStopFault=null;globalThis.fixtureLogoutAnswer?.({response:0,checkboxChecked:false})}).catch(()=>{})
    await instance?.close()
    try {tools.stopLogoutProcesses(owned)}
    finally {if(alive(unrelated.pid)) {const closed=once(unrelated,'exit');unrelated.kill();await closed}}
  }
}
