import assert from 'node:assert/strict'
import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'

/** 有界等待真实心跳或界面，不篡改生产时钟或用户的登录记录。 */
async function until(read, label) {
  const deadline=Date.now()+150_000
  while (Date.now()<deadline) {
    if (await read()) return
    await delay(200)
  }
  throw new Error(`P22 夹具超时：${label}`)
}

/** 读取临时工具心跳，允许文件原地写入期间的短暂不完整。 */
function heartbeat(root,name) {
  try {return JSON.parse(readFileSync(path.join(root,`${name}.json`),'utf8'))}
  catch {return null}
}

/** 真实短期限跨期验证原版后台终端、Cron、MCP 与桌面 PTY，不调用模型。 */
export async function exerciseExpiry(window,context,runtime,root,userData) {
  window.show()
  await delay(1000)
  const account=await window.webContents.executeJavaScript('window.hermesDesktop.getMaasAccount()')
  const encrypted=readFileSync(path.join(userData,'maas-login.enc'))
  writeFileSync(path.join(root,'expiry-login.enc'),encrypted)
  const home=path.join(context.home,'profiles','p22-work')
  mkdirSync(home,{recursive:true})
  writeFileSync(path.join(home,'config.yaml'),'terminal:\n  backend: local\ncron:\n  max_parallel_jobs: 2\n')
  const helper=path.join(context.installationRoot,'apps/desktop/scripts/account-work.fixture.py')
  const worker=runtime.spawnFixtureBackend(context.python,[helper,'work',root],{
    cwd:context.installationRoot,windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{...process.env,HERMES_HOME:home,PYTHONPATH:context.installationRoot,HERMES_PROFILE:'p22-work'}})
  let logs=''
  worker.stdout.on('data',data=>{logs+=data;writeFileSync(path.join(root,'expiry-work.log'),logs)})
  worker.stderr.on('data',data=>{logs+=data;writeFileSync(path.join(root,'expiry-work.log'),logs)})
  const pty=await window.webContents.executeJavaScript(`window.hermesDesktop.terminal.start({cwd:${JSON.stringify(root)}})`)
  const command=`& '${context.python.replaceAll("'","''")}' '${helper.replaceAll("'","''")}' pulse '${path.join(root,'pty.json').replaceAll("'","''")}'\r`
  await window.webContents.executeJavaScript(`window.hermesDesktop.terminal.write(${JSON.stringify(pty.id)},${JSON.stringify(command)})`)
  const names=['background','cron','mcp','pty']
  await until(()=>{
    if (worker.exitCode !== null) throw new Error(`原版工具提前结束：${logs}`)
    return names.every(name=>heartbeat(root,name)) && existsSync(path.join(root,'cron-short.txt'))
  },'全部真实工作启动')
  assert.ok(Date.now()<account.expiresAt,'任务须在原登录期限前启动')
  const before=names.map(name=>({name,...heartbeat(root,name)}))
  // 自动提示不应移动当前页面焦点。
  await window.webContents.executeJavaScript("document.body.tabIndex=-1; document.body.focus()")
  await until(()=>window.webContents.executeJavaScript("document.querySelector('[data-slot=statusbar]')?.textContent.includes('登录已到期')"),'真实到期提示')
  const atExpiry=names.map(name=>({name,...heartbeat(root,name)}))
  await until(()=>atExpiry.every(row=>heartbeat(root,row.name)?.tick>row.tick),'到期后全部继续执行')
  assert.equal(worker.exitCode,null)
  assert.equal(await window.webContents.executeJavaScript('document.activeElement===document.body'),true)
  assert.equal(globalThis.fixtureContext().id,context.id)
  assert.deepEqual(readFileSync(path.join(userData,'maas-login.enc')),encrypted)
  assert.equal(existsSync(path.join(userData,'maas-logout-pending.json')),false)
  const display=await window.webContents.executeJavaScript('window.hermesDesktop.getMaasAccount()')
  assert.deepEqual(display,account)
  const notices=await window.webContents.executeJavaScript("import('/src/store/notifications.ts').then(m=>m.$notifications.get().filter(n=>n.id==='maas-login-expired').length)")
  assert.equal(notices,1)
  writeFileSync(path.join(root,'expiry-notice.png'),(await window.webContents.capturePage()).toPNG())
  await window.webContents.executeJavaScript("import('/src/store/notifications.ts').then(m=>m.dismissNotification('maas-login-expired'))")
  for (let i=0;i<3;i++) await window.webContents.executeJavaScript("dispatchEvent(new Event('focus'))")
  await delay(300)
  assert.equal(await window.webContents.executeJavaScript("import('/src/store/notifications.ts').then(m=>m.$notifications.get().filter(n=>n.id==='maas-login-expired').length)"),0)
  await window.webContents.executeJavaScript('window.hermesDesktop.getConnection("p22-work")')
  writeFileSync(path.join(root,'expiry.png'),(await window.webContents.capturePage()).toPNG())
  writeFileSync(path.join(root,'expiry.json'),JSON.stringify({continued:true,originalExpiryKept:true,notices,
    pids:[worker.pid,...before.map(row=>row.pid)]}))
}
