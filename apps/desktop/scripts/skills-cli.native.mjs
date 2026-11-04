import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const desktop = path.resolve(import.meta.dirname, '..')
const repo = path.resolve(desktop, '../..')
const require = createRequire(path.join(desktop, 'package.json'))
const electron = require('electron')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'uniworker-skills-cli-'))
const userData = path.join(temporary, 'roaming')
const env = { ...process.env, LOCALAPPDATA: temporary, HERMES_DESKTOP_USER_DATA_DIR: userData,
  HERMES_DESKTOP_HERMES_ROOT: repo, PYTHONIOENCODING: 'utf-8', COLUMNS: '180' }
delete env.HERMES_HOME
delete env.ELECTRON_RUN_AS_NODE
fs.mkdirSync(userData)
const fixture = path.join(temporary, 'fixture.mjs')
await build({ stdin: { contents: `
import fs from 'node:fs'; import path from 'node:path'; import { app } from 'electron';
import { CredentialStore, MAAS_IDENTITY_NAMESPACE } from './electron/login/credential-store';
import { accountDataRoot, prepareAccountPaths } from './electron/entry_local/account-paths';
import { openSkillsCliState, blockSkillsCliState } from './electron/entry_local/skills-cli-state';
app.setName('Hermes Desktop MT');
app.setPath('userData', process.env.HERMES_DESKTOP_USER_DATA_DIR);
void app.whenReady().then(async () => {
 const userData = app.getPath('userData'); const uid = process.argv[2];
 const account = prepareAccountPaths({data:accountDataRoot(app.getPath('home')),userData}, MAAS_IDENTITY_NAMESPACE, uid);
 new CredentialStore(userData).save({uid,token:'controlled-token',expiresAt:Date.now()+(uid==='expired'?-1000:3600000),maskedPhone:'138****0000'});
 for (const [home,name] of [[account.home,uid+'-default'],[path.join(account.home,'profiles','expert'),uid+'-expert']]) {
  const directory=path.join(home,'skills',name); fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'SKILL.md'),'---\\nname: '+name+'\\ndescription: Isolated account fixture\\n---\\nRead this test skill.\\n');
  fs.writeFileSync(path.join(home,'config.yaml'),'{}');
 }
 fs.writeFileSync(path.join(userData,'expected-home'),account.home);
 if (process.argv[3]) {
  fs.writeFileSync(path.join(userData,'maas-logout-pending.json'),JSON.stringify({account:account.id,mode:'quit'}));
  if (process.argv[3]==='blocked-early') blockSkillsCliState();
  await openSkillsCliState(userData,account.id);
  if (process.argv[3]==='blocked') blockSkillsCliState();
  fs.writeFileSync(path.join(userData,'ready'),'ready'); setInterval(()=>{},1000);
 } else app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
`, resolveDir: desktop }, bundle: true, platform: 'node', format: 'esm', external: ['electron'], outfile: fixture,
 banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" } })

/** 启动隔离进程，收集输出并限制等待时间。 */
function run(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const throughShell = args[0] === desktop
    const entry = process.argv.includes('--registered') ? 'hermes' : `'${path.join(process.env.LOCALAPPDATA, 'uniworker/bin/hermes.cmd').replaceAll("'", "''")}'`
    const command = throughShell ? 'powershell.exe' : electron
    const commandArgs = throughShell ? ['-NoProfile', '-Command',
      `& ${entry} ${args.slice(2).map(value => "'" + value.replaceAll("'", "''") + "'").join(' ')}; exit $LASTEXITCODE`] : args
    const child = spawn(command, commandArgs, { env: { ...env, ...extraEnv }, windowsHide: true })
    let output = ''
    child.stdout.on('data', value => { output += value })
    child.stderr.on('data', value => { output += value })
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timeout')) }, 90000)
    child.once('error', reject)
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output }) })
  })
}
/** 通过正式 Electron 入口执行官方 CLI，并断言账号技能归属。 */
async function check(uid, profile = 'default', extraEnv = {}) {
  const result = await run([desktop, '--desktop-skills-cli', '--profile', profile, 'skills', 'list', '--source', 'local'], extraEnv)
  assert.equal(result.code, 0, result.output)
  assert.ok(result.output.includes(`${uid}-${profile}`), result.output)
  assert.ok(!result.output.includes(`${uid}-${profile === 'default' ? 'expert' : 'default'}`), result.output)
  console.log(`通过 ${uid}/${profile}`)
}

/** 用真实 Windows PTY 等待确认提示，再输入回答，覆盖交互式安装而非 --yes。 */
async function interactiveInstall(answer, shell = 'powershell') {
  const pty = require('node-pty')
  const command = 'hermes --profile default skills install official/creative/social-media-content-calendar'
  const git = spawnSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true }).stdout?.trim().split(/\r?\n/) ?? []
  const bash = git.map(file => path.resolve(path.dirname(file), '../bin/bash.exe')).find(file => fs.existsSync(file))
  const pwsh = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true }).stdout?.trim().split(/\r?\n/)[0]
  const shells = {
    powershell: ['powershell.exe', ['-NoProfile', '-NoLogo', '-Command', `${command}; exit $LASTEXITCODE`]],
    cmd: [process.env.ComSpec, ['/d', '/s', '/c', command]],
    pwsh: [pwsh, ['-NoProfile', '-NoLogo', '-Command', `${command}; exit $LASTEXITCODE`]],
    gitbash: [bash, ['--noprofile', '--norc', '-c', command]]
  }
  const [executable, args] = shells[shell]
  assert.ok(executable, `缺少 ${shell}，请安装对应终端后再运行定向检查。`)
  const terminal = pty.spawn(executable, args, {
    env, cwd: desktop, cols: 140, rows: 35
  })
  let output = ''
  let answered = false
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { terminal.kill(); reject(new Error(`交互确认超时：${output}`)) }, 90000)
    terminal.onData(data => {
      output += data
      if (!answered && output.includes('Confirm [y/N]:')) {
        answered = true
        terminal.write(`${answer}\r`)
      }
    })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer)
      if (!answered || (answer === 'y' && exitCode !== 0)) { reject(new Error(output)) }
      else { resolve() }
    })
  })
  fs.writeFileSync(path.join(temporary, `interactive-${shell}-${answer}.txt`), output)
  const accountHome = fs.readFileSync(path.join(userData, 'expected-home'), 'utf8')
  assert.equal(fs.existsSync(path.join(accountHome, 'skills/creative/social-media-content-calendar/SKILL.md')), answer === 'y', output)
  console.log(`真实 ${shell} 交互 ${answer} 通过`)
}

if (process.argv.includes('--shells-only')) {
  const selected = process.argv.find(value => value.startsWith('--shell='))?.slice('--shell='.length)
  for (const shell of selected ? [selected] : ['powershell', 'cmd', 'pwsh', 'gitbash']) {
    const prepared = await run([fixture, `interactive-${shell}`])
    assert.equal(prepared.code, 0, prepared.output)
    await interactiveInstall('n', shell)
    await interactiveInstall('y', shell)
  }
  console.log(`跨终端交互记录 ${temporary}`)
  process.exit(0)
}

if (process.argv.includes('--interactive-only')) {
  const prepared = await run([fixture, 'interactive-account'])
  assert.equal(prepared.code, 0, prepared.output)
  await interactiveInstall('n')
  await interactiveInstall('y')
  console.log(`交互记录 ${temporary}`)
  process.exit(0)
}

for (const uid of ['account-A', 'account-B', 'account-A']) {
  const result = await run([fixture, uid]); assert.equal(result.code, 0, result.output)
  await check(uid); await check(uid, 'expert')
}
const explicitHome = fs.readFileSync(path.join(userData, 'expected-home'), 'utf8')
if (process.argv.includes('--install')) {
  const installed = await run([desktop, '--desktop-skills-cli', '--profile', 'expert', 'skills', 'install',
    'official/creative/social-media-content-calendar', '--yes'])
  assert.equal(installed.code, 0, installed.output)
  const file = path.join('skills', 'creative', 'social-media-content-calendar', 'SKILL.md')
  assert.ok(fs.existsSync(path.join(explicitHome, 'profiles', 'expert', file)), installed.output)
  assert.ok(!fs.existsSync(path.join(explicitHome, file)))
  const listed = await run([desktop, '--desktop-skills-cli', '--profile', 'expert', 'skills', 'list', '--source', 'hub'])
  assert.equal(listed.code, 0, listed.output)
  assert.ok(listed.output.includes('social-media-content-calendar'), listed.output)
}
assert.equal((await run([fixture, 'expired'])).code, 0)
assert.notEqual((await run([desktop, '--desktop-skills-cli', 'skills', 'list'])).code, 0)
await check('account-A', 'default', { HERMES_HOME: explicitHome })
fs.writeFileSync(path.join(userData, 'maas-login.enc'), 'broken-cipher')
assert.notEqual((await run([desktop, '--desktop-skills-cli', 'skills', 'list'])).code, 0)
for (const mode of ['running', 'blocked', 'blocked-early']) {
  fs.rmSync(path.join(userData,'ready'), {force:true})
  const service = spawn(electron, [fixture, 'account-A', mode], { env, windowsHide: true, stdio: 'ignore' })
  try {
    const deadline = Date.now() + 15000
    while (!fs.existsSync(path.join(userData,'ready'))) {
      if (Date.now() > deadline) { throw new Error('状态夹具启动超时') }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (mode === 'running') { await check('account-A') }
    else { assert.notEqual((await run([desktop, '--desktop-skills-cli', 'skills', 'list'])).code, 0) }
  } finally {
    const closed = new Promise(resolve => service.once('exit', resolve)); service.kill(); await closed
  }
}
assert.notEqual((await run([desktop, '--desktop-skills-cli', 'skills', 'list'])).code, 0)
fs.rmSync(path.join(userData,'maas-logout-pending.json'))
await check('account-A')
fs.rmSync(path.join(userData,'maas-login.enc'))
assert.notEqual((await run([desktop, '--desktop-skills-cli', 'skills', 'list'])).code, 0)
console.log(`通过：跨进程加密读取、A→B→A、专家隔离、完整退出、运行中、退出中、崩溃待恢复、到期、损坏、无登录、显式 Home。记录 ${temporary}`)
