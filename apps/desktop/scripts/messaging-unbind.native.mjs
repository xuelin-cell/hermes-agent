import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { parseEnv } from 'node:util'

import { _electron as electron } from '@playwright/test'
import electronPath from 'electron'

import { prepareFixture } from './account-desktop.native.mjs'
import { prepareLoginRenderer, startLoginDevServer } from './login-renderer.fixture.mjs'
import { stagePythonPlugins } from './stage-python-plugins.mjs'

// 按名称只运行本用例，导入夹具中的其它账号验收不执行。
// node --test --test-name-pattern="飞书解绑" scripts/messaging-unbind.native.mjs
test('飞书解绑：原生页面清理不完整凭据，真实 IPC 和插件不依赖平台在线', { timeout: 240_000 }, async () => {
  const { server, url } = await startLoginDevServer()
  let instance

  try {
    const fixture = await prepareFixture(url)
    console.log(`飞书解绑夹具：${fixture.root}`)
    await mkdir(path.join(fixture.root, 'app-data'), { recursive: true })
    const renderer = await prepareLoginRenderer()
    // 显式准备正式分享资源，不依赖本机计时夹具中未提交的补充。
    await mkdir(path.join(renderer, 'assets'), { recursive: true })
    await cp(path.resolve('assets/artifact-share-plugin'), path.join(renderer, 'assets', 'artifact-share-plugin'), {
      recursive: true
    })
    // 临时壳按正式构建准备完整插件发现根，包含桌面消息接口和 5G 插件。
    stagePythonPlugins({ source: path.resolve('../..'), out: path.join(renderer, 'dist') })
    instance = await electron.launch({
      executablePath: electronPath,
      args: [fixture.output],
      timeout: 45_000,
      env: {
        ...fixture.env,
        APPDATA: path.join(fixture.root, 'app-data'),
        FIXTURE_PLAN: 'empty',
        FIXTURE_HOLD_STARTUP_FAILURE: '1',
        HERMES_DESKTOP_MT_SKIP_DEV_EXTRAS: '1'
      }
    })
    let page
    const deadline = Date.now() + 120_000

    while (Date.now() < deadline) {
      assert.deepEqual(await instance.evaluate(() => globalThis.fixtureErrors), [])
      page = instance.windows().find(window => window.url().startsWith('http') && !window.url().includes('login.html'))

      if (
        page &&
        (await page.evaluate(() => typeof window.hermesDesktop?.messagingStatus === 'function').catch(() => false))
      )
        break

      await new Promise(resolve => setTimeout(resolve, 300))
    }

    assert.ok(page, '隔离账号窗口未就绪')
    await page.waitForFunction(async () => (await window.hermesDesktop.messagingStatus()).phase === 'idle', undefined, {
      polling: 200,
      timeout: 45_000
    })
    const context = await instance.evaluate(() => globalThis.fixtureContext())
    assert.ok(context.home.startsWith(fixture.root), '只允许写入独立临时账号')
    const envFile = path.join(context.home, '.env')
    // 不完整凭据不能连接飞书；保留一个不参与连接的其它平台设置，检查不会被误删。
    await writeFile(envFile, 'FEISHU_APP_ID=fixture-incomplete-id\nDINGTALK_ALLOWED_USERS=fixture-owner\n')
    await page.evaluate(() => {
      location.hash = '/messaging'
    })
    const skip = page.getByRole('button', { name: /Skip for now|暂时跳过|暂不设置/i })

    if (await skip.isVisible().catch(() => false)) await skip.click()

    const card = page.getByRole('article', { name: /Feishu bot integration|飞书机器人集成/ })
    const unbind = card.getByRole('button', { name: /Disconnect|解绑/ })
    await unbind.waitFor({ timeout: 60_000 })
    await unbind.click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Disconnect|解绑/ })
      .click()
    await page.waitForFunction(
      async () => {
        const state = await window.hermesDesktop.messagingStatus()
        return state.operation === 'disconnect' && state.phase === 'completed'
      },
      undefined,
      { polling: 200, timeout: 60_000 }
    )
    await unbind.waitFor({ state: 'detached', timeout: 15_000 })
    const saved = parseEnv(await readFile(envFile, 'utf8'))
    assert.ok(!saved.FEISHU_APP_ID && !saved.FEISHU_APP_SECRET)
    assert.equal(saved.DINGTALK_ALLOWED_USERS, 'fixture-owner')
    assert.deepEqual(await instance.evaluate(() => globalThis.fixtureErrors), [])
    await page.screenshot({ path: path.join(fixture.root, 'feishu-unbound.png'), fullPage: true })
    console.log(`飞书解绑隔离验收：${fixture.root}`)
  } finally {
    await instance?.close()
    await server.close()
  }
})
