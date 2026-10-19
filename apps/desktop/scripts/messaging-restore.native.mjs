import assert from 'node:assert/strict'
import { access, cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { _electron as electron } from '@playwright/test'
import electronPath from 'electron'

import { prepareFixture } from './account-desktop.native.mjs'
import { prepareLoginRenderer, startLoginDevServer } from './login-renderer.fixture.mjs'

test('G04 原生桌面：未进入消息页面也执行恢复，无配置不启动网关且聊天后端可用', { timeout: 240_000 }, async () => {
  const { server, url } = await startLoginDevServer()
  let instance
  try {
    const fixture = await prepareFixture(url)
    const renderer = await prepareLoginRenderer()
    // 原有夹具只构建登录页，补入当前发行已有的分享插件资产；不修改原夹具。
    await mkdir(path.join(renderer, 'assets'), { recursive: true })
    await cp(path.resolve('assets/artifact-share-plugin'), path.join(renderer, 'assets/artifact-share-plugin'), { recursive: true })
    instance = await electron.launch({ executablePath: electronPath, args: [fixture.output], timeout: 45_000,
      env: { ...fixture.env, FIXTURE_PLAN: 'empty', FIXTURE_HOLD_STARTUP_FAILURE: '1', HERMES_DESKTOP_MT_SKIP_DEV_EXTRAS: '1' } })
    const deadline = Date.now() + 120_000
    let page
    while (Date.now() < deadline) {
      const errors = await instance.evaluate(() => globalThis.fixtureErrors)
      assert.deepEqual(errors, [], '原生启动发生错误')
      page = instance.windows().find(window => window.url() && !window.url().includes('login.html'))
      if (page && await page.evaluate(() => typeof window.hermesDesktop?.messagingStatus === 'function').catch(() => false)) break
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    assert.ok(page, '账号桌面未就绪')
    const connection = await page.evaluate(() => window.hermesDesktop.getConnection())
    assert.equal(new URL(connection.baseUrl).hostname, '127.0.0.1')
    const status = await page.evaluate(() => window.hermesDesktop.api({ method: 'GET', path: '/api/status' }))
    assert.ok(status && typeof status === 'object')
    assert.ok(!page.url().includes('/messaging'), '恢复不应依赖消息页面')
    await page.waitForFunction(async () => {
      const operation = await window.hermesDesktop.messagingStatus()
      return operation.operation === 'restore' && operation.phase === 'idle'
    }, undefined, { timeout: 45_000 })
    const context = await instance.evaluate(() => globalThis.fixtureContext())
    await assert.rejects(access(path.join(context.home, 'gateway.pid')), { code: 'ENOENT' })
    assert.ok(context.home.startsWith(fixture.root))
    console.log(`G04 隔离桌面检查：${fixture.root}`)
  } finally {
    if (instance) await instance.close()
    await server.close()
  }
})
