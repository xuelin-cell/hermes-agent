import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chromium } from '@playwright/test'
import { build, preview } from 'vite'

/** 使用正式页面、缓存和桥接调用入口检查首屏；网络响应受控，不访问用户账号或网关。 */
test('连接手机在慢响应前显示卡片，返回页面复用缓存', { timeout: 180_000 }, async () => {
  const desktop = path.resolve(import.meta.dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uniworker-messaging-loading-'))
  const entry = path.join(root, 'fixture.jsx')
  const resolve = createRequire(import.meta.url).resolve
  /** 让隔离入口引用正式组件，不复制产品展示或加载逻辑。 */
  const source = name => JSON.stringify(path.join(desktop, name))
  await fs.writeFile(
    entry,
    `
    import React,{useState} from ${JSON.stringify(resolve('react'))}
    import {createRoot} from ${JSON.stringify(resolve('react-dom/client'))}
    import {MemoryRouter} from ${JSON.stringify(resolve('react-router'))}
    import {QueryClientProvider} from ${JSON.stringify(resolve('@tanstack/react-query').replace(/\.cjs$/, '.js'))}
    import {queryClient} from ${source('src/lib/query-client.ts')}
    import {I18nProvider} from ${source('src/i18n/context.tsx')}
    import {ThemeProvider} from ${source('src/themes/context.tsx')}
    import {RootTooltipProvider} from ${source('src/components/ui/tooltip.tsx')}
    import {MessagingView} from ${source('src/app/messaging/index.tsx')}
    import ${source('src/styles.css')}
    // 只控制页面挂载；状态和请求合并均走正式实现。
    function Fixture(){
      const [open,setOpen]=useState(false)
      window.setMessagingOpen=setOpen
      return <MemoryRouter><I18nProvider configClient={null} initialLocale="zh">
        <div style={{height:'100vh'}}>{open?<MessagingView/>:<div>其它页面</div>}</div>
      </I18nProvider></MemoryRouter>
    }
    createRoot(document.getElementById('root')).render(<QueryClientProvider client={queryClient}>
      <ThemeProvider><RootTooltipProvider><Fixture/></RootTooltipProvider></ThemeProvider>
    </QueryClientProvider>)
  `
  )
  const output = path.join(root, 'renderer')
  await build({
    root: desktop,
    logLevel: 'warn',
    build: {
      outDir: output,
      emptyOutDir: true,
      manifest: 'manifest.json',
      reportCompressedSize: false,
      minify: false,
      rolldownOptions: { input: entry }
    }
  })
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'))
  const built = Object.values(manifest).find(item => item.isEntry)
  await fs.writeFile(
    path.join(output, 'index.html'),
    '<!doctype html><html data-hermes-theme="uniwork"><meta charset="utf-8">' +
      (built.css || []).map(name => `<link rel="stylesheet" href="./${name}">`).join('') +
      `<body style="margin:0"><div id="root"></div><script type="module" src="./${built.file}"></script></body></html>`
  )
  const server = await preview({
    root: desktop,
    logLevel: 'error',
    build: { outDir: output },
    preview: { host: '127.0.0.1', port: 0, strictPort: false, open: false }
  })
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 1080 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      window.fixtureReads = 0
      window.fixtureDiagnostics = 0
      window.hermesDesktop = {
        messagingStatus: async () => ({ phase: 'idle', revision: 0 }),
        onMessagingStatus: () => () => {},
        api: request => {
          if (request.path === '/api/plugins/desktop-messaging/platforms') {
            window.fixtureReads++
            if (window.fixtureResponse) {
              return Promise.resolve(window.fixtureResponse)
            }
            return new Promise(resolve => {
              window.releasePlatforms = response => {
                window.fixtureResponse = response
                resolve(response)
              }
            })
          }
          if (request.path === '/api/status') {
            window.fixtureDiagnostics++
            return Promise.resolve({})
          }
          throw new Error('Unexpected fixture request: ' + request.path)
        }
      }
    })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'load' })
    await page.waitForFunction(() => typeof window.setMessagingOpen === 'function')
    /** 从点击对应的挂载动作计时到卡片绘制，不包含已完成的脚本下载和编译。 */
    async function openAndMeasure() {
      return page.evaluate(
        () =>
          new Promise(resolve => {
            const started = performance.now()
            window.setMessagingOpen(true)
            // 等到五张正式卡片均有布局，并再过一帧确认绘制机会。
            function checkPaint() {
              if (document.querySelectorAll('article').length === 5) {
                requestAnimationFrame(() => resolve(Math.round(performance.now() - started)))
              } else {
                requestAnimationFrame(checkPaint)
              }
            }
            requestAnimationFrame(checkPaint)
          })
      )
    }
    const firstMs = await openAndMeasure()
    assert.ok(firstMs < 1000, `首次卡片展示 ${firstMs}ms`)
    assert.equal(await page.getByText('正在确认聊天应用状态…', { exact: true }).count(), 5)
    await page.screenshot({ path: path.join(root, 'first-paint.png'), fullPage: true })
    await page.evaluate(() =>
      window.releasePlatforms({
        platforms: ['weixin', 'dingtalk', 'feishu', 'wecom', 'uniagentgate'].map(id => ({
          id,
          name: id,
          description: '',
          docs_url: '',
          configured: true,
          enabled: true,
          gateway_running: true,
          state: 'connected',
          env_vars: []
        }))
      })
    )
    await page.waitForFunction(
      () => [...document.querySelectorAll('[role="status"]')].filter(node => node.textContent === '已连接').length === 5
    )
    assert.equal(await page.evaluate(() => window.fixtureDiagnostics), 0)
    await page.evaluate(() => {
      window.fixtureResponse = null
      window.setMessagingOpen(false)
    })
    await page.getByText('其它页面', { exact: true }).waitFor()
    const returnMs = await openAndMeasure()
    assert.ok(returnMs < 1000, `返回卡片展示 ${returnMs}ms`)
    // 返回仍保留已绑定平台的入口，但新状态确认前禁用操作。
    assert.equal(await page.getByText('正在确认聊天应用状态…', { exact: true }).count(), 0)
    assert.ok((await page.getByRole('button', { name: '解绑', exact: true }).count()) >= 4)
    assert.equal(await page.getByRole('button', { name: '解绑', exact: true }).first().isDisabled(), true)
    await page.screenshot({ path: path.join(root, 'cached-return.png'), fullPage: true })
    assert.deepEqual(errors, [])
    const report = {
      firstMs,
      returnMs,
      diagnostics: await page.evaluate(() => window.fixtureDiagnostics),
      boundary: '正式页面与生产构建，受控桥接响应；不含应用冷启动、真实 IPC 或外部平台连接耗时。'
    }
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ root, ...report }))
  } finally {
    await browser?.close()
    await server.close()
  }
})
