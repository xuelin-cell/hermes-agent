import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import WebSocket from 'ws'
import { parse, stringify } from 'yaml'

// 独立真实协议验收；不启动桌面窗口，不访问 MaaS 或调用模型。
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(desktop, '../..')
const python =
  process.env.HERMES_TEST_PYTHON ||
  path.join(repo, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-shared-backend-'))
const bundle = path.join(root, 'production.mjs')
await build({
  stdin: {
    contents: `
  export {resolveProfileApiRequest, pathWithProfileScope} from './electron/connection-config';
  export {SharedProfileStartup} from './electron/entry_local/shared-profile-startup';
  export {CloudDriveMcp} from './electron/login/cloud-drive-mcp';
`,
    resolveDir: desktop
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
  banner: { js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);" }
})
const { resolveProfileApiRequest, pathWithProfileScope, SharedProfileStartup, CloudDriveMcp } = await import(
  pathToFileURL(bundle).href
)

/** 只在临时账号目录写入测试配置、受管专家索引和文件。 */
async function prepareAccount(account) {
  const home = path.join(root, account)
  for (const profile of ['default', 'expert-a', 'expert-b']) {
    const target = profile === 'default' ? home : path.join(home, 'profiles', profile)
    await fs.mkdir(path.join(target, 'imported-plugins'), { recursive: true })
    const config = {
      model: { provider: 'custom', default: 'fixture-unused-model', base_url: 'http://127.0.0.1:9/v1' },
      custom_prompt: `${account}/${profile}`,
      plugins: { enabled: ['uniwork-kits'], disabled: [] },
      uniwork_kits: { bundled_dir: path.join(root, 'no-bundled-kits') },
      mcp_servers: {}
    }
    await fs.writeFile(path.join(target, 'config.yaml'), stringify(config))
    await fs.writeFile(path.join(target, '.env'), '')
    await fs.writeFile(
      path.join(target, 'imported-plugins', 'index.json'),
      JSON.stringify({
        version: 1,
        plugins:
          profile === 'default'
            ? Object.fromEntries(['expert-a', 'expert-b'].map(name => [name, { kind: 'expert', profile: name }]))
            : { [profile]: { kind: 'expert', self: true } }
      })
    )
  }
  return home
}

/** 拉起唯一的账号后端，端口由操作系统分配；环境只携带系统必需项。 */
async function startBackend(home, label) {
  const token = randomBytes(32).toString('hex')
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext|temp|tmp|lang)$/i.test(key))
  )
  Object.assign(env, {
    HERMES_HOME: home,
    HOME: root,
    USERPROFILE: root,
    HERMES_SERVE_HEADLESS: '1',
    HERMES_DASHBOARD_SESSION_TOKEN: token,
    HERMES_BUNDLED_PLUGINS: path.join(repo, 'plugins'),
    PYTHONIOENCODING: 'utf-8'
  })
  const script = `import sys, os
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from hermes_state import SessionDB
root = Path(os.environ['HERMES_HOME'])
for home in [root, root / 'profiles' / 'expert-a', root / 'profiles' / 'expert-b']:
    db = SessionDB(home / 'state.db')
    if not db.get_session('fixture-session'):
        db.create_session('fixture-session', 'desktop')
    db.close()
from hermes_cli.web_server import start_server
start_server(port=0, open_browser=False, headless=True, isolated=True)
`
  const child = spawn(python, ['-I', '-c', script, repo], {
    cwd: repo,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  /** 结束且只结束此夹具创建的 Python 进程，并保存隔离日志供复核。 */
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    await fs.writeFile(path.join(root, `${label}.log`), log)
  }
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Backend startup timed out (${label})`)), 120_000)
      /** 从原版就绪行提取临时端口，不依赖固定端口或已有后端。 */
      const read = chunk => {
        log += chunk.toString()
        const match = log.match(/HERMES_BACKEND_READY port=(\d+)/)
        if (match) {
          clearTimeout(timer)
          resolve(Number(match[1]))
        }
      }
      child.stdout.on('data', read)
      child.stderr.on('data', read)
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(`Backend exited (${label}, ${code})`))
      })
    })
    const base = `http://127.0.0.1:${port}`
    /** 通过正式 Electron 路由器选择请求路径，并证明没有选择池进程。 */
    const api = async (profile, method, route, body) => {
      const target = resolveProfileApiRequest(profile, route, {
        primaryProfile: 'default',
        requestMethod: method,
        isolatedBackend: false
      })
      assert.equal(target.backendProfile, null)
      const response = await fetch(base + target.requestPath, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      })
      return response
    }
    return { child, base, token, api, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

/** 在同一条真实 WS 上查询多个 Profile，校验 RPC 不串到启动目录。 */
async function checkSocket(backend, account) {
  const socket = new WebSocket(`${backend.base.replace('http:', 'ws:')}/api/ws?token=${backend.token}`)
  try {
    await once(socket, 'open')
    let sequence = 0
    for (const profile of ['expert-a', 'expert-b', 'expert-a']) {
      const id = String(++sequence)
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.off('message', read)
          reject(new Error('WS RPC timed out'))
        }, 30_000)
        /** 忽略通知，只接收本次带编号的原版 JSON-RPC 响应。 */
        const read = data => {
          const message = JSON.parse(data.toString())
          if (message.id !== id) {
            return
          }
          clearTimeout(timer)
          socket.off('message', read)
          resolve(message)
        }
        socket.on('message', read)
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'config.get', params: { key: 'prompt', profile } }))
      })
      assert.equal(response.error, undefined)
      assert.equal(response.result.prompt, `${account}/${profile}`)
    }
  } finally {
    socket.terminate()
  }
}

/** 使用同一个后端验证 Profile 配置、会话修改与删除，以及运行中新助手准备。 */
async function checkAccount(home, account, round) {
  const backend = await startBackend(home, `${account}-${round}`)
  const drive = new CloudDriveMcp({}, home, path.join(home, 'workspace'))
  const logs = []
  const syncs = []
  const refreshes = []
  const shared = new SharedProfileStartup({
    home,
    appRoot: desktop,
    drive,
    interrupted: {
      /** 本夹具没有运行中对话，只验证 Profile 准备与路由，不制作中断标记。 */
      claim() {}
    },
    active: () => backend.child.exitCode === null,
    refreshConnectors: async profile => {
      refreshes.push(profile)
    },
    log: message => logs.push(message)
  })
  try {
    for (const profile of ['expert-a', 'expert-b', 'expert-a']) {
      const response = await backend.api(profile, 'GET', '/api/config?include_defaults=false')
      assert.equal(response.status, 200)
      assert.equal((await response.json()).custom_prompt, `${account}/${profile}`)
    }
    await checkSocket(backend, account)
    const renamed = await backend.api('expert-b', 'PATCH', '/api/sessions/fixture-session', {
      profile: 'expert-b',
      title: `${account}-renamed`
    })
    assert.equal(renamed.status, 200)
    const transcript = await backend.api('expert-b', 'GET', '/api/sessions/fixture-session')
    assert.ok((await transcript.text()).includes(`${account}-renamed`))
    assert.equal((await backend.api('expert-a', 'DELETE', '/api/sessions/fixture-session')).status, 200)
    assert.equal((await backend.api('expert-a', 'GET', '/api/sessions/fixture-session')).status, 404)
    assert.equal((await backend.api('expert-b', 'GET', '/api/sessions/fixture-session')).status, 200)
    const model = `model-${account}-${round}`
    assert.equal(
      (await backend.api('default', 'PUT', '/api/config', { config: { model: { default: model } } })).status,
      200
    )
    /** 编排直接使用已认证的当前账号连接，与 main.ts 的共用分支一致。 */
    const profileApi = profile => async (method, route, body) => {
      const pending = fetch(backend.base + pathWithProfileScope(route, profile), {
        method,
        headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      }).then(async response => {
        assert.equal(response.status, 200, `${method} ${route}`)
        return response.json()
      })
      if (route.endsWith('/expert-sync')) {
        syncs.push(pending)
      }
      return pending
    }
    await Promise.all(['expert-a', 'expert-b', 'expert-a'].map(profile => shared.ensure(profile, profileApi(profile))))
    await Promise.all(syncs)
    assert.deepEqual(refreshes.sort(), ['expert-a', 'expert-b'])
    assert.deepEqual(logs, [])
    for (const profile of ['expert-a', 'expert-b']) {
      const saved = parse(await fs.readFile(path.join(home, 'profiles', profile, 'config.yaml'), 'utf8'))
      assert.equal(saved.model.default, model)
      assert.equal(saved.custom_prompt, `${account}/${profile}`)
      assert.ok(saved.plugins.enabled.includes('desktop-artifact-share'))
      assert.ok(Object.values(saved.mcp_servers).some(entry => entry.url?.startsWith('http://127.0.0.1:')))
    }
    console.log(`${account}/${round}: REST, WebSocket, session ownership and runtime preparation passed`)
  } finally {
    await drive.close()
    await backend.stop()
  }
}

try {
  const a = await prepareAccount('account-a')
  const b = await prepareAccount('account-b')
  for (const [home, account, round] of [
    [a, 'account-a', 1],
    [b, 'account-b', 1],
    [a, 'account-a', 2]
  ]) {
    await checkAccount(home, account, round)
  }
  console.log(`PASS: ${root}`)
} catch (error) {
  console.error(`FAIL: ${root}`)
  throw error
}
