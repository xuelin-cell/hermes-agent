import assert from 'node:assert/strict'
import {spawn, execFile} from 'node:child_process'
import {mkdir, writeFile} from 'node:fs/promises'
import {createServer} from 'node:net'
import path from 'node:path'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'

const execute = promisify(execFile)
const children = []

/** 用原版重启观察器的 argv 形状模拟尚未完成的拉起，进程由夹具持有。 */
export function startFixtureRestartWatcher(context, external=false) {
  const child=spawn(context.python,['-c','import time; time.sleep(120)','0',context.python,
    '-m','hermes_cli.main','gateway','run',...(external ? ['--external-supervisor'] : [])],{
    cwd:context.installationRoot,env:{...process.env,HERMES_HOME:context.home,PYTHONPATH:context.installationRoot},
    stdio:'ignore',windowsHide:true})
  children.push(child)
  return child
}

/** 获取仅用于本轮隔离网关的回环端口。 */
async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

/** 原版入口与 API server 真正运行；仅访问健康检查，不调用模型。 */
export async function startFixtureGateway(context, home) {
  const port = await freePort()
  await mkdir(home,{recursive:true})
  await writeFile(path.join(home,'config.yaml'), `gateway:\n  standalone: true\nplatforms:\n  api_server:\n    enabled: true\n    extra:\n      host: 127.0.0.1\n      port: ${port}\n      key: gateway-fixture-only-key-not-a-secret-123456789\n`)
  const env = {...process.env,HERMES_HOME:home,PYTHONPATH:context.installationRoot,
    HERMES_SKIP_INTRO:'1',HERMES_GATEWAY_DETACHED:'1',PYTHONIOENCODING:'utf-8',
    HERMES_GATEWAY_LOCK_DIR:path.join(home,'gateway-locks')}
  if (context.fixtureAppData) env.APPDATA=context.fixtureAppData
  for (const key of Object.keys(env)) {
    if (/^(HERMES_DESKTOP_|HERMES_PROFILE$|ELECTRON_RUN_AS_NODE$)/.test(key)) delete env[key]
  }
  const child = spawn(context.python,['-m','hermes_cli.main','gateway','run'],{
    env,cwd:context.installationRoot,stdio:['ignore','pipe','pipe'],windowsHide:true})
  children.push(child)
  let logs = ''
  child.stdout.on('data',data => {logs=(logs+data).slice(-12_000)})
  child.stderr.on('data',data => {logs=(logs+data).slice(-12_000)})
  const deadline = Date.now()+60_000
  while (Date.now()<deadline) {
    if (child.exitCode !== null) throw new Error(`真实网关退出 ${child.exitCode}: ${logs}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)})
      if (response.ok) return {child,home,port}
    } catch {}
    await delay(200)
  }
  throw new Error(`真实网关启动超时: ${logs}`)
}

/** 调用正式桌面适配脚本，不用模拟停止结果替代进程验证。 */
export async function gatewayOperation(context, operation, saved = []) {
  const script = path.join(context.installationRoot,'apps/desktop/electron/entry_local/gateway-logout.py')
  const child = spawn(context.python,[script], {cwd:context.installationRoot,
    env:{...process.env,HERMES_HOME:context.home,PYTHONPATH:context.installationRoot,PYTHONIOENCODING:'utf-8',
      ...(context.fixtureAppData ? {APPDATA:context.fixtureAppData} : {})},
    windowsHide:true,stdio:['pipe','pipe','pipe']})
  let output='',error=''
  child.stdout.on('data',data => {output+=data})
  child.stderr.on('data',data => {error+=data})
  child.stdin.end(JSON.stringify({operation,saved})+'\n')
  const timer=setTimeout(() => child.kill(),95_000)
  try {
    const code=await new Promise((resolve,reject) => {child.once('close',resolve);child.once('error',reject)})
    assert.equal(code,0,error)
    const response=JSON.parse(output)
    assert.equal(response.error,undefined,'网关停止验证失败')
    return response.gateways
  } finally {clearTimeout(timer)}
}

/** 用原版生成器制作隔离 Startup 文件；计划任务只有受控动作，不注册登录触发器。 */
export async function prepareFixtureAutostart(context, home, taskName) {
  const env={...process.env,HERMES_HOME:home,PYTHONPATH:context.installationRoot,
    APPDATA:context.fixtureAppData,PYTHONIOENCODING:'utf-8'}
  const program = "from hermes_cli import gateway_windows as w; p=w.get_task_script_path(); p.parent.mkdir(parents=True,exist_ok=True); w._write_task_script(); entry=w.get_startup_entry_path(); entry.parent.mkdir(parents=True,exist_ok=True); entry.write_text(w._build_startup_launcher(p),encoding='utf-8',newline=''); print(p.with_suffix('.vbs'))"
  const {stdout}=await execute(context.python,['-c',program],{env,cwd:context.installationRoot,windowsHide:true,timeout:15_000})
  const script=stdout.trim()
  const command = `$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $d=$s.NewTask(0); $d.Settings.Enabled=$true; $d.Settings.RestartCount=3; $d.Settings.RestartInterval='PT1M'; $a=$d.Actions.Create(0); $a.Path='wscript.exe'; $a.Arguments='//B //Nologo "'+$env:FIXTURE_SCRIPT+'"'; $s.GetFolder('\\').RegisterTaskDefinition($env:FIXTURE_TASK,$d,6,$null,$null,3) | Out-Null`
  await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{
    env:{...env,FIXTURE_SCRIPT:script,FIXTURE_TASK:taskName},windowsHide:true,timeout:15_000})
}

/** 读取或移除本轮精确命名的临时任务；不枚举并删除用户已有任务。 */
export async function fixtureTask(taskName, remove=false) {
  const command = `$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $f=$s.GetFolder('\\'); if ($env:FIXTURE_REMOVE -eq '1') {$f.DeleteTask($env:FIXTURE_TASK,0)} else {$t=$f.GetTask($env:FIXTURE_TASK); [bool]$t.Enabled | ConvertTo-Json -Compress}`
  const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{
    env:{...process.env,FIXTURE_TASK:taskName,FIXTURE_REMOVE:remove?'1':'0'},windowsHide:true,timeout:15_000})
  return remove ? null : JSON.parse(stdout)
}

/** 只收尾夹具亲自创建且仍持有句柄的子树，不扫描用户或官方网关。 */
export async function cleanupFixtureGateways() {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      await execute('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:15_000}).catch(() => {})
    }
  }
}
