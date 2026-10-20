/* global document, window, FontFace */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'
import electronPath from 'electron'
import { createServer, loadConfigFromFile } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const desktop = path.resolve(import.meta.dirname, '..')
const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-conversation-render-'))
const entry = path.join(root, 'fixture.tsx')
/** 将正式源码路径安全嵌入隔离夹具入口。 */
const source = relative => JSON.stringify(path.join(desktop, relative))
await writeFile(
  entry,
  `
import {createRoot} from 'react-dom/client'
import {flushSync} from 'react-dom'
import {useEffect} from 'react'
import {ThemeProvider,useTheme} from ${source('src/themes/context.tsx')}
import { exportConversationHtml } from ${source('src/components/conversation-share/snapshot-renderer.tsx')}
import ${source('src/styles.css')}
const source = {
 schemaVersion:1,snapshotId:'a'.repeat(64),scope:'session',title:'会话分享 · 排版验证',locale:'zh',theme:'light',rendererVersion:1,
 assets:[{reference:'figure.png',path:'/workspace/figure.png',hash:'b'.repeat(64)}],
 messages:[
 {role:'user',blocks:[{type:'markdown',text:'请展示代码、表格、公式和流程图。'}]},
 {role:'assistant',blocks:[{type:'reasoning',text:'先检查数据，再形成结论。'},
 {type:'markdown',text:'# 完整分享示例\\n\\n中文与 **Markdown** 正文。\\n\\n| 项目 | 状态 |\\n| --- | --- |\\n| 完整历史 | 通过 |\\n\\n公式：$x^2 + y^2 = z^2$\\n\\n\`\`\`typescript\\nconst greeting = "你好";\\nconsole.log(greeting);\\n\`\`\`\\n\\n\`\`\`mermaid\\nflowchart LR\\n A[准备快照] --> B[静态预览] --> C[发布链接]\\n\`\`\`'},
 {type:'markdown',text:'![内嵌图片](figure.png)'},{type:'markdown',text:'MEDIA:/workspace/result.md'},{type:'tool',name:'read_file'}]},
 ...Array.from({length:30},(_,i)=>({role:'assistant',blocks:[{type:'markdown',text:'第 '+i+' 段完整历史。'}]}))]
};
const labels = {readonly:'只读会话快照',user:'你',assistant:'助手',process:'思考过程',resourceError:'准备失败'};
// 重新导出以验证主题变化和静态资源准备。
function ThemeControl(){
 const {setMode}=useTheme();
 useEffect(()=>{
 window.exportAgain=async (dark=false,response=false)=>{
 flushSync(()=>setMode(dark?'dark':'light'));
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 const html=await exportConversationHtml({...source,theme:dark?'dark':'light',...(response?{scope:'response',title:'分享的回复',messages:source.messages.filter(item=>item.role==='assistant')}:{})},labels,AbortSignal.timeout(60000),async reference=>{if(reference!=='figure.png')throw Error('Unexpected image');return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='});
 window.fixtureHtml=html;
 const frame=document.querySelector('iframe');frame.srcdoc=html;
 return html;
};
queueMicrotask(()=>window.exportAgain().then(()=>window.fixtureReady=true).catch(error=>window.fixtureError=String(error)));
 },[setMode]);return null;}
 createRoot(document.createElement('div')).render(<ThemeProvider><ThemeControl/></ThemeProvider>);
`
)
const { config } = await loadConfigFromFile(
  { command: 'serve', mode: 'development' },
  path.join(desktop, 'vite.config.ts')
)
const server = await createServer({
  configFile: false,
  root: desktop,
  cacheDir: path.join(root, 'cache'),
  logLevel: 'warn',
  resolve: config.resolve,
  optimizeDeps: { ...config.optimizeDeps, entries: [entry] },
  server: { host: '127.0.0.1', port: 0, open: false, fs: { allow: [path.resolve(desktop, '../..'), root] } },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'conversation-export-fixture',
      /** 独立入口加载正式导出模块与产品样式，不读取用户会话或调用公网服务。 */
      configureServer(vite) {
        vite.middlewares.use('/fixture.html', async (_request, response, next) => {
          try {
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            response.end(
              await vite.transformIndexHtml(
                '/fixture.html',
                `<!doctype html><html><head><meta charset="utf-8"></head><body><iframe title="分享预览" style="width:100vw;height:100vh;border:0" sandbox="allow-same-origin"></iframe><script type="module" src="/@fs/${entry}"></script></body></html>`
              )
            )
          } catch (error) {
            next(error)
          }
        })
      }
    }
  ]
})
let instance
try {
  await server.listen()
  await writeFile(
    path.join(root, 'main.cjs'),
    `
const {app,BrowserWindow}=require('electron');
app.disableHardwareAcceleration();app.setPath('userData',${JSON.stringify(path.join(root, 'user-data'))});
app.whenReady().then(()=>{const win=new BrowserWindow({width:1100,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.loadURL('about:blank')});
app.on('window-all-closed',()=>app.quit());
`
  )
  instance = await electron.launch({
    executablePath: electronPath,
    args: [path.join(root, 'main.cjs')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
  })
  const page = await instance.firstWindow()
  let rejectFont = false
  const fontBytes = await readFile(
    path.resolve(desktop, '../../node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2')
  )
  await page.route('https://share-fonts.example/**', route => {
    const isCss = route.request().url().endsWith('.css')
    return route.fulfill({
      status: rejectFont ? 403 : 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      contentType: isCss ? 'text/css' : 'font/woff2',
      body: isCss
        ? '@layer fixture{@font-face{font-family:Fixture;src:url(./fixture.woff2);unicode-range:U+0-FFFF}}'
        : fontBytes
    })
  })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  // Vite 冷启动重新优化依赖会触发一次 504 和页面重载，不属于导出页面的运行错误。
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('504 (Outdated Optimize Dep)'))
      errors.push(message.text())
  })
  await page.goto(`${server.resolvedUrls.local[0]}fixture.html`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await expect
    .poll(() => page.evaluate(() => window.fixtureReady || window.fixtureError), { timeout: 120000 })
    .toBeTruthy()
  const error = await page.evaluate(() => window.fixtureError)
  assert.equal(error, undefined)
  const frame = page.frameLocator('iframe')
  await expect(frame.getByText('第 29 段完整历史。')).toBeVisible()
  assert.equal((await frame.locator('svg').count()) > 0, true)
  assert.equal((await frame.locator('.katex').count()) > 0, true)
  assert.equal((await frame.locator('pre code').count()) > 0, true)
  await expect(frame.locator('article img')).toHaveAttribute('src', /^data:image\/png;base64,/)
  assert.equal(await frame.locator('article img').evaluate(image => image.complete && image.naturalWidth > 0), true)
  const html = await page.evaluate(() => window.fixtureHtml)
  assert.equal(/<script|blob:|file:\/\/|src="https?:/i.test(html), false)
  await writeFile(path.join(root, 'share.html'), html)
  console.log('分享页面已写入：' + root)
  assert.equal(html.includes('准备快照'), true)
  assert.equal(html.includes('>Hermes<'), false)
  await expect(frame.getByRole('img', { name: '元景数字员工', exact: true })).toBeVisible()
  await expect(frame.locator('header img')).toHaveAttribute('src', /^data:image\/png;base64,/)
  assert.equal(html.includes('MEDIA:'), false)
  assert.equal(html.includes('/workspace/result.md'), false)
  assert.equal(html.includes('result.md'), true)
  // 连续助手片段只显示一个角色标识；导出的公开页保留样式且不依赖应用 CSS。
  await expect(frame.locator('article')).toHaveCount(2)
  await expect(frame.getByText('助手', { exact: true })).toHaveCount(1)
  const headerBorder = await frame.locator('header').evaluate(node => getComputedStyle(node).borderBottomWidth)
  assert.notEqual(headerBorder, '0px')
  const tableWidth = await frame.locator('table').evaluate(node => node.getBoundingClientRect().width)
  assert.ok(tableWidth > 500)
  await frame
    .locator('details')
    .first()
    .evaluate(node => (node.open = true))
  await page.screenshot({ path: path.join(root, 'light.png') })
  const responseHtml = await page.evaluate(() => window.exportAgain(false, true))
  await expect(frame.locator('article')).toHaveCount(1)
  await expect(frame.getByText('请展示代码、表格、公式和流程图。', { exact: true })).toHaveCount(0)
  await writeFile(path.join(root, 'response.html'), responseHtml)
  await page.screenshot({ path: path.join(root, 'response.png') })
  await page.evaluate(() => window.exportAgain())
  // 主题遗留的未使用字体样式不应成为分享正文的网络依赖。
  let unusedReads = 0
  await page.route('https://unused-fonts.example/theme.css', route => {
    unusedReads += 1
    return unusedReads === 1
      ? route.fulfill({
          status: 200,
          contentType: 'text/css',
          body: '@font-face{font-family:UnusedTheme;src:url(https://unused-fonts.example/font.woff2)}'
        })
      : route.abort('failed')
  })
  await page.evaluate(async () => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'https://unused-fonts.example/theme.css'
    const loaded = new Promise((resolve, reject) => {
      link.onload = resolve
      link.onerror = reject
    })
    document.head.append(link)
    await loaded
  })
  await page.evaluate(() => window.exportAgain())
  assert.equal(unusedReads, 1)
  await page.evaluate(() => document.querySelector('link[href*="unused-fonts.example"]').remove())
  // 其他界面的字体仍在加载时，快照不能等待整个文档的 fonts.ready。
  const pendingFonts = []
  await page.route('https://pending-fonts.example/**', route => pendingFonts.push(route))
  await page.evaluate(() => {
    const font = new FontFace('UnrelatedPending', 'url(https://pending-fonts.example/font.woff2)')
    document.fonts.add(font)
    const node = document.createElement('span')
    node.id = 'unrelated-font'
    node.textContent = 'Unrelated view'
    node.style.cssText = 'position:absolute;left:-10000px;font-family:UnrelatedPending'
    document.body.append(node)
    node.getBoundingClientRect()
    void font.load()
  })
  await expect.poll(() => pendingFonts.length).toBe(1)
  assert.equal(await page.evaluate(() => document.fonts.status), 'loading')
  await page.evaluate(() => window.exportAgain())
  assert.equal(await page.evaluate(() => document.fonts.status), 'loading')
  await pendingFonts[0].fulfill({
    status: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    contentType: 'font/woff2',
    body: fontBytes
  })
  await page.evaluate(async () => {
    await document.fonts.ready
    document.querySelector('#unrelated-font').remove()
  })
  // 模拟主题注入的跨域字体：普通 link 可应用，但禁止直接访问其 cssRules。
  await page.evaluate(async () => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'https://share-fonts.example/theme.css'
    const loaded = new Promise((resolve, reject) => {
      link.onload = resolve
      link.onerror = reject
    })
    document.head.append(link)
    await loaded
    const style = document.createElement('style')
    style.textContent = 'article {font-family:Fixture !important}'
    document.head.append(style)
    await document.fonts.load('16px Fixture')
  })
  const cssError = await page.evaluate(() => {
    const sheet = [...document.styleSheets].find(item => item.href?.includes('share-fonts.example'))
    try {
      return sheet.cssRules.length
    } catch (error) {
      return error.name
    }
  })
  assert.equal(cssError, 'SecurityError')
  const withFont = await page.evaluate(() => window.exportAgain())
  assert.match(withFont, /font-family:\s*Fixture/)
  assert.match(withFont, /unicode-range:\s*U\+0-FFFF/i)
  assert.match(withFont, /data:font\/woff2;base64/)
  assert.equal(withFont.includes('share-fonts.example'), false)
  const loadedFont = await frame.locator('body').evaluate(async () => {
    await document.fonts.load('16px Fixture')
    return [...document.fonts].find(font => font.family === 'Fixture')?.status
  })
  assert.equal(loadedFont, 'loaded')
  // 资源真实不可用时必须拒绝导出，不能靠忽略错误生成残缺页面。
  rejectFont = true
  await assert.rejects(() => page.evaluate(() => window.exportAgain()), /Resource 403/)
  assert.equal(errors.pop(), 'Failed to load resource: the server responded with a status of 403 (Forbidden)')
  rejectFont = false
  await frame
    .locator('details')
    .first()
    .evaluate(element => {
      element.open = true
    })
  // 带测试字体的页面不覆盖前面正常主题下的公开页截图。
  await page.evaluate(() => window.exportAgain(true))
  await expect(frame.locator('html')).toHaveAttribute('style', 'color-scheme:dark')
  await page.screenshot({ path: path.join(root, 'dark.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(root, 'narrow.png') })
  // 从 file URL 单独打开真正交付的 HTML，确认排版不会因丢失应用样式而退化。
  await page.goto(pathToFileURL(path.join(root, 'response.html')).href)
  await expect(page.getByRole('img', { name: '元景数字员工', exact: true })).toBeVisible()
  await expect(page.locator('article')).toHaveCount(1)
  assert.ok(await page.locator('body').evaluate(node => node.scrollWidth <= innerWidth))
  await page.screenshot({ path: path.join(root, 'response-mobile.png') })
  await page.setViewportSize({ width: 1100, height: 900 })
  const layout = await page.locator('main').evaluate(node => ({
    x: node.getBoundingClientRect().x,
    width: node.getBoundingClientRect().width,
    viewport: document.documentElement.clientWidth
  }))
  assert.ok(Math.abs(layout.x - (layout.viewport - layout.width) / 2) < 2)
  await page.screenshot({ path: path.join(root, 'response-standalone.png') })
  const font = pathToFileURL(path.resolve(desktop, '../../node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2')).href
  await writeFile(path.join(root, 'font.css'), `@font-face{font-family:Fixture;src:url(${font})}`)
  await writeFile(
    path.join(root, 'file-mode.html'),
    '<!doctype html><link rel="stylesheet" href="./font.css"><p>Packaged file origin</p>'
  )
  await page.goto(pathToFileURL(path.join(root, 'file-mode.html')).href)
  const fileOrigin = await page.evaluate(
    async font => ({
      rules: document.styleSheets[0].cssRules.length,
      bytes: (await (await fetch(font)).arrayBuffer()).byteLength
    }),
    font
  )
  assert.equal(fileOrigin.rules, 1)
  assert.equal(fileOrigin.bytes > 0, true)
  assert.deepEqual(errors, [])
  console.log(`会话分享真实渲染验证及截图：${root}`)
} finally {
  await instance?.close()
  await server.close()
}
