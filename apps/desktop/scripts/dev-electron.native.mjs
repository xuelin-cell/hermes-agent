import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import concurrently from 'concurrently'
import { prepareLoginRenderer } from './login-renderer.fixture.mjs'

const desktop = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

/** 在同一 concurrently 启动链中运行真实 Vite、开发监督进程和隔离 Electron。 */
async function runFixture(mode, signal) {
  const rendererRoot = await prepareLoginRenderer()
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-mt-relaunch-'))
  const trace = path.join(root, 'trace.jsonl')
  const serverInfo = path.join(root, 'vite.json')
  const electronFixture = path.join(root, 'electron.mjs')
  const supervisorFixture = path.join(root, 'supervisor.mjs')
  const viteFixture = path.join(root, 'vite.mjs')
  await writeFile(trace, '')
  await build({
    stdin: {
      resolveDir: desktop,
      contents: String.raw`
        import assert from 'node:assert/strict'
        import { readFileSync, appendFileSync, existsSync } from 'node:fs'
        import { setTimeout as delay } from 'node:timers/promises'
        import { app, BrowserWindow, net } from 'electron'
        // 重启回归不向上游请求验证码。
        net.fetch = async () => Response.json({code:1})
        app.setAppPath(${JSON.stringify(rendererRoot)})
        import { relaunchDesktop } from './electron/desktop-relaunch.ts'
        await import('./electron/entry.ts')
        // 等待窗口和 Vite 就绪后再触发重启，不添加生产调试入口。
        void app.whenReady().then(async () => {
          const trace = ${JSON.stringify(trace)}
          const starts = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
          const prior = starts.at(-1)
          if (prior) assert.throws(() => process.kill(prior.pid, 0), { code: 'ESRCH' })
          const deadline = Date.now() + 15000
          while (!existsSync(${JSON.stringify(serverInfo)}) || !BrowserWindow.getAllWindows()[0]?.isVisible()) {
            if (Date.now() > deadline) throw new Error('窗口或 Vite 未就绪: ' + JSON.stringify({ vite: existsSync(${JSON.stringify(serverInfo)}), windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), loading: window.webContents.isLoading() })) }))
            await delay(50)
          }
          const vite = JSON.parse(readFileSync(${JSON.stringify(serverInfo)}, 'utf8'))
          const response = await fetch(vite.url + '/@vite/client')
          assert.equal(response.status, 200)
          appendFileSync(trace, JSON.stringify({ pid: process.pid, vitePid: vite.pid, cwd: process.cwd(), windows: BrowserWindow.getAllWindows().length }) + '\n')
          if (${JSON.stringify(mode)} === 'crash') return app.exit(7)
          if (${JSON.stringify(mode)} === 'requested-crash') {
            await new Promise((resolve, reject) => process.send({type: 'hermes-desktop:relaunch'}, error => error ? reject(error) : resolve()))
            return app.exit(8)
          }
          if (starts.length < 2) {
            const pending = relaunchDesktop()
            assert.equal(pending, relaunchDesktop())
            await pending
          } else {
            BrowserWindow.getAllWindows()[0].close()
          }
        }).catch(error => { console.error(error); app.exit(1) })
      `
    },
    bundle: true, platform: 'node', format: 'esm', target: 'node20', external: ['electron'], outfile: electronFixture
  })
  await writeFile(supervisorFixture, `
    import { superviseElectron } from ${JSON.stringify(pathToFileURL(path.join(desktop, 'scripts/dev-electron.mjs')).href)}
    process.exitCode = await superviseElectron({ args: [${JSON.stringify(electronFixture)}] })
  `)
  await writeFile(viteFixture, `
    import { createServer } from ${JSON.stringify(pathToFileURL(require.resolve('vite')).href)}
    import { writeFileSync } from 'node:fs'
    const server = await createServer({ root: ${JSON.stringify(root)}, configFile: false, cacheDir: ${JSON.stringify(path.join(root, 'vite-cache'))}, optimizeDeps: { noDiscovery: true }, server: { host: '127.0.0.1', port: 0 } })
    await server.listen()
    writeFileSync(${JSON.stringify(serverInfo)}, JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:' + server.httpServer.address().port }))
  `)
  const env = {
    HERMES_HOME: path.join(root, 'hermes-home'),
    HERMES_DESKTOP_USER_DATA_DIR: path.join(root, 'desktop-state')
  }
  const run = concurrently([
    { name: 'electron', command: `"${process.execPath}" "${supervisorFixture}"`, env },
    { name: 'vite', command: `"${process.execPath}" "${viteFixture}"`, env }
  ], { cwd: desktop, killOthersOn: ['success', 'failure'], successCondition: 'first' })
  /** 测试超时只关闭本夹具创建的命令树，避免遗留 Electron 或 Vite。 */
  const stop = () => run.commands.forEach(command => command.kill())
  signal.addEventListener('abort', stop, { once: true })
  // 失败也等到整条启动链退出，再读取证据，避免把残留进程当作通过。
  let events
  try {
    events = await run.result.catch(events => events)
  } finally {
    signal.removeEventListener('abort', stop)
  }
  const records = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const vite = JSON.parse(await readFile(serverInfo, 'utf8'))
  assert.throws(() => process.kill(vite.pid, 0), { code: 'ESRCH' })
  await assert.rejects(fetch(vite.url, { signal: AbortSignal.timeout(2000) }))
  console.log(`开发重启真实验收目录：${root}`)
  return { events, records }
}

test('连续两次重启保持同一 Vite，旧 Electron 先退出，最后正常关闭整条启动链', { timeout: 60_000 }, async context => {
  const { events, records } = await runFixture('restart', context.signal)
  assert.equal(events[0].exitCode, 0)
  assert.equal(records.length, 3)
  assert.equal(new Set(records.map(record => record.pid)).size, 3)
  assert.equal(new Set(records.map(record => record.vitePid)).size, 1)
  assert.ok(records.every(record => record.windows === 1 && record.cwd === desktop))
})

test('崩溃不自动重试，已有重启意图也不能把异常退出当成成功', { timeout: 60_000 }, async context => {
  for (const [mode, code] of [['crash', 7], ['requested-crash', 8]]) {
    const { events, records } = await runFixture(mode, context.signal)
    assert.equal(events[0].exitCode, code)
    assert.equal(records.length, 1)
  }
})
