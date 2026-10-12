import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { build } from 'esbuild'
import { parse, stringify } from 'yaml'

const desktop = path.resolve(import.meta.dirname, '..')
const source = path.resolve(desktop, '../..')
const execute = promisify(execFile)

/** 每次用新进程恢复受控身份和套餐，执行正式账号环境准备与配置写入。 */
async function prepareAccount(bundle, roots, uid, baseUrl) {
  const { stdout } = await execute(process.execPath, ['-e', `
    const { LoginSession, prepareLocalEnvironment } = require(process.argv[1])
    const [roots, uid, baseUrl] = JSON.parse(process.argv[2])
    const session = new LoginSession(async () => Response.json({
      apiKey: 'fixture-model-key-' + uid,
      models: { models: ['fixture-first', 'fixture-second'].map(model => ({ id: model, model, base_url: baseUrl })) }
    }), { load: () => ({ uid, token: 'fixture-login-token', maskedPhone: '138****0000', expiresAt: Date.now() + 60_000 }) })
    if (!session.restore().ok) throw new Error('fixture restore failed')
    session.queryPlan().then(() => {
      console.log(JSON.stringify(prepareLocalEnvironment(session, roots)))
      session.dispose()
    }).catch(error => { console.error(error.cause?.message || error.message); process.exitCode = 1 })
  `, bundle, JSON.stringify([roots, uid, baseUrl])], { cwd: source, windowsHide: true, timeout: 30_000 })

  return JSON.parse(stdout)
}

/** 原版 REST 读写只针对临时账号；清除继承凭据，模型探测只访问本机夹具。 */
async function originalEndpoint(home, root, save) {
  const env = { ...process.env, HERMES_HOME: home, HERMES_RUNTIME_DIR: path.join(home, 'runtime') }

  for (const key of Object.keys(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) || /^(HERMES_PROFILE|HERMES_ACTIVE_PROFILE|PYTHONPATH|PYTHONHOME)$/.test(key)) {
      delete env[key]
    }
  }

  const { stdout } = await execute(process.env.FIXTURE_PYTHON, ['-c', `
import json, sys
from pathlib import Path
from unittest.mock import patch
with patch.object(Path, 'home', return_value=Path(sys.argv[2])):
    from fastapi.testclient import TestClient
    from hermes_cli.web_server import app, _SESSION_TOKEN
    from hermes_cli.config import read_raw_config
    client = TestClient(app, headers={'X-Hermes-Session-Token': _SESSION_TOKEN})
    response = client.get('/api/providers/custom-endpoints')
    assert response.status_code == 200, response.text
    endpoint = next(row for row in response.json()['endpoints'] if row['id'].startswith('desktop-mt-maas-'))
    if sys.argv[1] == 'save':
        response = client.post('/api/providers/custom-endpoints', json={
            'id': endpoint['id'], 'name': endpoint['name'], 'base_url': endpoint['base_url'],
            'model': 'fixture-second', 'models': endpoint['models'], 'api_mode': endpoint['api_mode'],
            'discover_models': False, 'context_length': 8192, 'make_default': True
        })
        assert response.status_code == 200, response.text
        assert response.json()['ok'] is True
    print(json.dumps(read_raw_config()))
  `, save ? 'save' : 'read', root], { cwd: source, env, windowsHide: true, timeout: 60_000, maxBuffer: 1_048_576 })

  return JSON.parse(stdout)
}

test('原版 REST 保存 MaaS 端点后，A→B→A 冷启动保留模型选择与账号文件，真实冲突仍拒绝',
  { timeout: 240_000 }, async () => {
    assert.ok(process.env.FIXTURE_PYTHON, '请用 FIXTURE_PYTHON 指定包含 web 依赖的独立测试解释器')
    const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-maas-roundtrip-'))
    const roots = { data: path.join(root, 'data'), userData: path.join(root, 'desktop') }
    const bundle = path.join(root, 'prepare.cjs')
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: ['fixture-first', 'fixture-second'].map(id => ({ id, object: 'model' })) }))
    })
    const accounts = new Map()

    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      await build({ stdin: { contents: `
        export { LoginSession } from './electron/login/session'
        export { prepareLocalEnvironment } from './electron/entry_local/prepare-account'
      `, resolveDir: desktop, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
        external: ['electron'],
        banner: { js: `var require = require('node:module').createRequire(${JSON.stringify(path.join(desktop, 'package.json'))})` } })

      for (const uid of ['account-A', 'account-B', 'account-A']) {
        const baseUrl = `http://127.0.0.1:${server.address().port}/${uid}/v1`
        const account = await prepareAccount(bundle, roots, uid, baseUrl)
        const file = path.join(account.home, 'config.yaml')
        const marker = path.join(account.workspace, 'keep.txt')

        if (!accounts.has(uid)) {
          await writeFile(marker, uid)
          const config = parse(await readFile(file, 'utf8'))
          config.providers.personal = { api: 'https://personal.invalid/v1', key_env: 'PERSONAL_KEY', models: { personal: {} } }
          config.skills = { enabled: ['fixture-skill'] }
          config.mcp_servers = { fixture: { command: 'fixture-not-started' } }
          await writeFile(file, stringify(config))
          accounts.set(uid, account)
        }

        const saved = await originalEndpoint(account.home, root, true)
        const id = Object.keys(saved.providers).find(key => key.startsWith('desktop-mt-maas-'))
        assert.equal(saved.providers[id].base_url, baseUrl)
        assert.equal(saved.providers[id].api_mode, 'chat_completions')
        assert.equal(saved.providers[id].transport, undefined)
        const foreign = [...accounts.entries()].find(([key]) => key !== uid)?.[1]
        const foreignFile = foreign && path.join(foreign.home, 'config.yaml')
        const foreignBytes = foreignFile && await readFile(foreignFile)

        assert.deepEqual(await prepareAccount(bundle, roots, uid, baseUrl), account)
        const refreshed = await originalEndpoint(account.home, root, false)
        assert.deepEqual(refreshed.model, saved.model)
        assert.deepEqual(refreshed.providers.personal, saved.providers.personal)
        assert.deepEqual(refreshed.skills, saved.skills)
        assert.deepEqual(refreshed.mcp_servers, saved.mcp_servers)
        assert.equal(refreshed.providers[id].models['fixture-second'].context_length, 8192)
        assert.equal(refreshed.providers[id].key_env, 'DESKTOP_MT_MAAS_API_KEY')
        assert.equal(await readFile(marker, 'utf8'), uid)
        assert.match(await readFile(path.join(account.home, '.env'), 'utf8'), new RegExp(`fixture-model-key-${uid}`))
        if (foreignFile) assert.deepEqual(await readFile(foreignFile), foreignBytes)
      }

      const account = accounts.get('account-A')
      const file = path.join(account.home, 'config.yaml')
      const changed = parse(await readFile(file, 'utf8'))
      const id = Object.keys(changed.providers).find(key => key.startsWith('desktop-mt-maas-'))
      changed.providers[id].base_url = 'https://different.invalid/v1'
      await writeFile(file, stringify(changed))
      const before = await readFile(file)
      await assert.rejects(prepareAccount(bundle, roots, 'account-A', changed.providers[id].api), /归属或覆盖冲突/)
      assert.deepEqual(await readFile(file), before)
    } finally {
      await new Promise(resolve => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    }
  })
