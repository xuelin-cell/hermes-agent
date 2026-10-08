import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { cleanupFixtureGateways, gatewayOperation, startFixtureGateway } from './gateway-logout.fixture.mjs'

test('网关缺失落盘创建时间仍按实时身份停止，冲突记录和其他账号不被误停',
  { timeout: 180_000, skip: process.platform !== 'win32' }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-gateway-identity-'))
    const source = path.resolve(import.meta.dirname, '../../..')
    const context = {
      installationRoot: source,
      python: path.join(source, '.venv/Scripts/python.exe'),
      home: path.join(root, 'account-a')
    }
    console.log(`网关身份回归目录：${root}`)
    try {
      const own = await startFixtureGateway(context, context.home)
      const foreign = await startFixtureGateway(context, path.join(root, 'account-b'))
      const file = path.join(own.home, 'gateway.pid')
      const record = JSON.parse(await readFile(file, 'utf8'))
      const config = await readFile(path.join(own.home, 'config.yaml'), 'utf8')
      const saved = await gatewayOperation(context, 'snapshot')

      await writeFile(file, JSON.stringify({ ...record, start_time: record.start_time + 100 }))
      await assert.rejects(gatewayOperation(context, 'stop', saved), /网关停止验证失败/)
      assert.equal((await fetch(`http://127.0.0.1:${own.port}/health`)).ok, true)

      await writeFile(file, JSON.stringify({ ...record, start_time: null }))
      await gatewayOperation(context, 'stop', saved)
      await gatewayOperation(context, 'check')
      await assert.rejects(fetch(`http://127.0.0.1:${own.port}/health`))
      assert.equal((await fetch(`http://127.0.0.1:${foreign.port}/health`)).ok, true)
      assert.equal(await readFile(path.join(own.home, 'config.yaml'), 'utf8'), config)
    } finally {
      await cleanupFixtureGateways()
    }
  })
