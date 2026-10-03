import assert from 'node:assert/strict'
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {app, BrowserWindow} from 'electron'
import {startFixtureGateway, gatewayOperation} from './gateway-logout.fixture.mjs'

/** 等待隔离窗口中的真实条件，失败不无限挂住开发监督进程。 */
async function until(read, label) {
  const deadline = Date.now()+90_000
  while (Date.now()<deadline) {
    const value = await read()
    if (value) return value
    await delay(100)
  }
  throw new Error(`退出夹具超时：${label}`)
}

/** 真实 Renderer 确认、受限 IPC、Windows 进程与开发监督重启串联验证。 */
export async function exerciseLogout(root, userData) {
  await app.whenReady()
  const flag = path.join(root,'logout-started')
  if (existsSync(flag)) {
    const login = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('login.html')),'登录窗')
    await until(() => login.webContents.executeJavaScript("Boolean(window.hermesLogin && document.body.textContent.includes('登录 Hermes'))"),'登录页')
    assert.equal(globalThis.fixtureContext(),null)
    assert.equal(existsSync(path.join(userData,'maas-login.enc')),false)
    writeFileSync(path.join(root,'logout-after.json'),JSON.stringify({electron:process.pid,login:true}))
    login.close()
    return
  }
  const window = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http') && !w.webContents.getURL().includes('login.html')),'桌面窗')
  await until(() => window.webContents.executeJavaScript("Boolean(window.hermesDesktop && Array.from(document.querySelectorAll('[data-slot=statusbar] button')).some(b=>b.textContent==='退出'))"),'退出按钮')
  const context = globalThis.fixtureContext()
  const gateway = await startFixtureGateway(context,path.join(context.home,'profiles','gateway-check'))
  const gateways = await gatewayOperation(context,'snapshot')
  assert.ok(gateways.some(row => row.home===gateway.home))
  writeFileSync(path.join(root,'logout-gateway.json'),JSON.stringify({context,gateways}))
  const connection = await window.webContents.executeJavaScript('window.hermesDesktop.getConnection()')
  const ledger = JSON.parse(readFileSync(path.join(context.home,'spawn-ledger.json'),'utf8'))
    .find(item => item.port===Number(new URL(connection.baseUrl).port) && item.purpose==='serve')
  assert.ok(ledger?.pid)
  writeFileSync(path.join(context.workspace,'logout-history-sentinel.txt'),'preserve account files')
  const runtime = await globalThis.fixtureMain()
  const leafFile = path.join(root,'logout-leaf.json')
  const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); fs.writeFileSync(${JSON.stringify(leafFile)},JSON.stringify({pid:child.pid})); setInterval(()=>{},1000)`
  const controlled = runtime.spawnFixtureBackend(process.env.FIXTURE_NODE,['-e',script],{stdio:'ignore',windowsHide:true})
  await until(() => existsSync(leafFile),'受控孙进程')
  const leaf = JSON.parse(readFileSync(leafFile,'utf8')).pid
  writeFileSync(path.join(root,'logout-before.json'),JSON.stringify({electron:process.pid,backend:ledger.pid,controlled:controlled.pid,leaf,context,gateways}))
  await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('[data-slot=statusbar] button')).find(b=>b.textContent==='退出').click()")
  await until(() => window.webContents.executeJavaScript("Boolean(document.querySelector('[role=dialog]'))"),'退出确认')
  window.show()
  await delay(1000)
  writeFileSync(path.join(root,'logout-confirm.png'),(await window.webContents.capturePage()).toPNG())
  writeFileSync(flag,'requested')
  void window.webContents.executeJavaScript("Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent==='退出').click()").catch(() => {})
}
