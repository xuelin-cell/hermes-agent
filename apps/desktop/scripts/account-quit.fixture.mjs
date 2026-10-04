import assert from 'node:assert/strict'
import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {app, BrowserWindow} from 'electron'

/** 有界等待真实文件或窗口条件，未就绪时保留诊断。 */
async function until(read, label) {
  const deadline=Date.now()+90_000
  while (Date.now()<deadline) {
    const value=await read()
    if (value) return value
    await delay(200)
  }
  throw new Error(`P21 夹具超时：${label}`)
}

/** 读取可能正在写入的测试心跳，绝不读取用户文件。 */
function heartbeat(root, name) {
  try { return JSON.parse(readFileSync(path.join(root,`${name}.json`),'utf8')) }
  catch { return null }
}

/** 真实窗口关闭到托盘后继续执行三类工具，再走正常退出或托盘菜单退出。 */
export async function exerciseQuit(root, userData) {
  await app.whenReady()
  const window=await until(() => BrowserWindow.getAllWindows().find(w =>
    w.webContents.getURL().startsWith('http') && !w.webContents.getURL().includes('login.html')),'聊天窗')
  await until(() => window.webContents.executeJavaScript('Boolean(window.hermesDesktop?.terminal)'), '页面桥接')
  const context=globalThis.fixtureContext()
  const runtime=await globalThis.fixtureMain()
  const home=path.join(context.home,'profiles','p21-work')
  mkdirSync(home,{recursive:true})
  writeFileSync(path.join(home,'config.yaml'),'terminal:\n  backend: local\ncron:\n  max_parallel_jobs: 2\n')
  const helper=path.join(context.installationRoot,'apps/desktop/scripts/account-work.fixture.py')
  const child=runtime.spawnFixtureBackend(context.python,[helper,'work',root],{
    cwd:context.installationRoot,windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{...process.env,HERMES_HOME:home,PYTHONPATH:context.installationRoot,
      HERMES_PROFILE:'p21-work',PYTHONIOENCODING:'utf-8'}})
  let logs=''
  child.stdout.on('data',data=>{logs+=data;writeFileSync(path.join(root,'work.log'),logs)})
  child.stderr.on('data',data=>{logs+=data;writeFileSync(path.join(root,'work.log'),logs)})
  const pty=await window.webContents.executeJavaScript(`window.hermesDesktop.terminal.start({cwd:${JSON.stringify(root)}})`)
  const ptyCommand=`& '${context.python.replaceAll("'","''")}' '${helper.replaceAll("'","''")}' pulse '${path.join(root,'pty.json').replaceAll("'","''")}'\r`
  await window.webContents.executeJavaScript(`window.hermesDesktop.terminal.write(${JSON.stringify(pty.id)},${JSON.stringify(ptyCommand)})`)
  const names=['background','cron','mcp','pty']
  await until(() => {
    if (child.exitCode !== null) throw new Error(`原版工具进程提前结束：${logs}`)
    return names.every(name=>heartbeat(root,name)) && existsSync(path.join(root,'cron-short.txt'))
  },
    '后台命令、短定时任务、长定时任务、MCP 与 PTY')
  const before=names.map(name=>({name,...heartbeat(root,name)}))
  const status=await runtime.tray.setEnabled(true)
  assert.equal(status.available,true)
  window.close()
  assert.equal(window.isDestroyed(),false)
  assert.equal(window.isVisible(),false)
  await until(() => before.every(row=>heartbeat(root,row.name)?.tick>row.tick),'隐藏期间全部继续工作')
  assert.equal(child.exitCode,null)
  const connection=await window.webContents.executeJavaScript('window.hermesDesktop.getConnection()')
  const ledger=JSON.parse(readFileSync(path.join(context.home,'spawn-ledger.json'),'utf8'))
    .find(row=>row.port===Number(new URL(connection.baseUrl).port) && row.purpose==='serve')
  assert.ok(ledger?.pid)
  writeFileSync(path.join(root,'quit-before.json'),JSON.stringify({context,home,electron:process.pid,
    backend:ledger.pid,worker:child.pid,work:before,userData,hiddenContinued:true}))
  // 先取消一次，确认密文、窗口和工具都没进入停止；再真正确认。
  const runningRecord=readFileSync(path.join(userData,'maas-logout-pending.json'))
  globalThis.fixtureDialogResponse=0
  app.quit()
  await until(()=>globalThis.fixtureErrors.some(text=>text==='退出 Hermes Desktop MT？'),'统一退出提示')
  await delay(100)
  assert.equal(child.exitCode,null)
  assert.deepEqual(readFileSync(path.join(userData,'maas-logout-pending.json')),runningRecord)
  globalThis.fixtureDialogResponse=1
  if (process.env.FIXTURE_QUIT_TEST==='tray') {
    const item=globalThis.fixtureTrayMenu.items.find(item=>item.label==='Quit Hermes')
    assert.ok(item)
    item.click()
  } else {
    await runtime.tray.setEnabled(false)
    window.close()
  }
}
