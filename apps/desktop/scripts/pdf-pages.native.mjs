import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { _electron as electron, expect } from '@playwright/test'
import { build as bundle } from 'esbuild'
import electronPath from 'electron'
import { build, createServer } from 'vite'

const desktop = path.resolve(import.meta.dirname, '..')
const inputs = process.argv.slice(2)
if (!inputs.length) {
  console.log('只读取现成 PDF，不启动 Office。用法：node scripts/pdf-pages.native.mjs <MS Office PDF> <WPS PDF>')
  process.exit(0)
}

/** 正式 Vite 开发与生产配置、真实 Electron Worker／画布，独立窗口不启动 Hermes 或 Office。 */
test('P10 开发与生产页面均可离线逐页绘制中文 PDF', { timeout: 120000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-pdf-pages-'))
  console.log('PDF 逐页渲染记录：' + root)
  const entry = path.join(root, 'fixture.js')
  const modulePath = path.join(desktop, 'src/app/chat/right-rail/formats/pdf-pages.ts').replaceAll('\\', '/')
  await fs.writeFile(entry, `import { openPdfPages } from ${JSON.stringify(modulePath)}; window.openPdfPages=openPdfPages;`)
  const html = '<!doctype html><meta charset="utf-8"><title>独立 PDF 渲染检查</title>'
  // 临时入口位于 /@fs；显式复现正式开发页的根地址，不能把资源误解析到临时文件夹下。
  await fs.writeFile(path.join(root, 'dev.html'), `${html}<base href="/"><script type="module" src="/@fs/${entry.replaceAll('\\', '/')}"></script>`)
  const output = path.join(root, 'renderer')
  await build({ root: desktop, logLevel: 'warn', build: { outDir: output, emptyOutDir: true, manifest: 'manifest.json', reportCompressedSize: false, rolldownOptions: { input: entry } } })
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'))
  const built = Object.values(manifest).find(item => item.isEntry)
  await fs.writeFile(path.join(output, 'index.html'), `${html}<script type="module" src="./${built.file}"></script>`)
  const server = await createServer({ root: desktop, logLevel: 'warn', optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null, fs: { allow: [root, path.resolve(desktop, '../..')] } } })
  let app
  const report = []
  const messages = []
  const resources = ['cmaps/Adobe-GB1-UCS2.bcmap', 'standard_fonts/LiberationSans-Regular.ttf', 'wasm/openjpeg.wasm', 'iccs/CGATS001Compat-v2-micro.icc']
  try {
    await server.listen()
    await bundle({ stdin: { contents: `
      import { app, BrowserWindow } from 'electron'
      app.disableHardwareAcceleration()
      app.setPath('userData',${JSON.stringify(path.join(root, 'user-data'))})
      app.whenReady().then(()=>{
        const window=new BrowserWindow({show:false,width:1680,height:1050,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
        window.loadURL('about:blank')
      })
      app.on('window-all-closed',()=>app.quit())
    `, resolveDir: desktop }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(root, 'main.cjs') })
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ executablePath: electronPath, args: [path.join(root, 'main.cjs')], cwd: desktop, env })
    const page = await app.firstWindow()
    const workers = []
    const external = []
    page.on('worker', worker => workers.push(worker.url()))
    page.on('console', message => messages.push({ type: message.type(), text: message.text() }))
    page.on('pageerror', error => messages.push({ type: 'pageerror', text: String(error) }))
    await page.route('**/*', route => {
      const url = route.request().url()
      if (/^(file:|blob:|data:|http:\/\/127\.0\.0\.1:)/.test(url)) { return route.continue() }
      external.push(url)

      return route.abort()
    })
    for (const [mode, url] of [
      ['dev', `${server.resolvedUrls.local[0]}@fs/${path.join(root, 'dev.html').replaceAll('\\', '/')}`],
      ['production-file', pathToFileURL(path.join(output, 'index.html')).href]
    ]) {
      await page.goto(url)
      await page.waitForFunction(() => typeof window.openPdfPages === 'function')
      const fetched = await page.evaluate(paths => Promise.all(paths.map(file => new Promise((resolve, reject) => {
        const request = new XMLHttpRequest()
        request.open('GET', new URL('pdfjs/' + file, document.baseURI))
        request.responseType = 'arraybuffer'
        request.onload = () => resolve({ file, length: request.response?.byteLength, header: [...new Uint8Array(request.response).slice(0, 16)] })
        request.onerror = reject
        request.send()
      }))), resources)
      for (const resource of fetched) {
        const expected = await fs.readFile(path.join(output, 'pdfjs', resource.file))
        assert.equal(resource.length, expected.length, `${mode} ${resource.file} 资源长度`)
        assert.deepEqual(resource.header, [...expected.subarray(0, 16)], `${mode} ${resource.file} 资源内容`)
      }
      for (let index = 0; index < inputs.length; index++) {
        const bytes = [...await fs.readFile(inputs[index])]
        const before = workers.length
        const result = await page.evaluate(async bytes => {
          const reader = await window.openPdfPages(Uint8Array.from(bytes))
          window.pdfReader = reader
          const urls = []
          for (let number = 1; number <= reader.pages.length; number++) {
            const image = new Image()
            image.src = await reader.renderPage(number)
            await image.decode()
            image.alt = `page-${number}`
            image.style.display = 'block'
            document.body.appendChild(image)
            const png = [...new Uint8Array(await (await fetch(image.src)).arrayBuffer())]
            urls.push({ width: image.naturalWidth, height: image.naturalHeight, png })
          }

          return { pages: reader.pages, images: urls }
        }, bytes)
        assert.ok(result.pages.length > 0)
        assert.ok(result.images.every(image => Math.max(image.width, image.height) === 1600))
        assert.ok(workers.length > before, '必须启动真实 Worker，不能以主线程降级冒充通过')
        for (let number = 1; number <= result.pages.length; number++) {
          await fs.writeFile(path.join(root, `${mode}-${index + 1}-${number}.png`), new Uint8Array(result.images[number - 1].png))
          delete result.images[number - 1].png
        }
        report.push({ mode, source: path.resolve(inputs[index]), ...result, worker: workers.at(-1), resources: fetched })
        await page.evaluate(async () => { await window.pdfReader.dispose(); document.body.replaceChildren() })
        await expect.poll(() => page.workers().length).toBe(0)
      }
    }
    assert.deepEqual(external, [])
    assert.ok(!messages.some(message => message.type === 'pageerror' || /fake worker|Error:/.test(message.text)), JSON.stringify(messages))
    console.log(JSON.stringify(report))
  } finally {
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ report, messages }, null, 2))
    await app?.close()
    await server.close()
  }
})
