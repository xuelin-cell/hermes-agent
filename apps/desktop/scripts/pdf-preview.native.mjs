/* global window, getSelection, getComputedStyle, MutationObserver -- Playwright 回调在独立 Electron Renderer 中执行。 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { _electron as electron, expect } from '@playwright/test'
import { build as bundle } from 'esbuild'
import electronPath from 'electron'
import { build, createServer } from 'vite'

import { realOfficePdfs } from './pdf-preview.office-fixture.mjs'

if (!process.argv.includes('--run')) {
  console.log(
    '独立 PDF/PPT 预览验收：node scripts/pdf-preview.native.mjs --run [已有 PDF] [--office]；只有显式 --office 才启动 Office'
  )
  process.exit(0)
}
const desktop = path.resolve(import.meta.dirname, '..')
const resolve = createRequire(import.meta.url).resolve

/** 生成带可选文字的确定性多页 PDF，不依赖 Office、模型或额外文档库。 */
function samplePdf(count, width = 612, height = 792) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids = []
  for (let number = 1; number <= count; number++) {
    const page = objects.length + 1
    kids.push(`${page} 0 R`)
    const stream = `BT /F1 24 Tf 40 ${height - 60} Td (StageTwo page ${number}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    )
  }
  objects[1] = `<< /Type /Pages /Count ${count} /Kids [${kids.join(' ')}] >>`
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('')
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)
}

/** 实际绘制、选字、搜索、缩放及 PPT 回看；--office 使用真实转换字节，其余场景用受控结果。 */
test('桌面 PDF 与 Office 结果在开发、生产页面共用本机 Worker，分页预览可交互和回看', { timeout: 240000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-pdf-viewer-'))
  console.log('PDF/PPT 预览记录：' + root)
  const plain = path.join(root, 'sample.pdf')
  const existing = process.argv.filter(arg => !['--run', '--office'].includes(arg)).slice(2)[0]
  await fs.writeFile(plain, existing ? await fs.readFile(existing) : samplePdf(8))
  const office = process.argv.includes('--office') ? await realOfficePdfs(root, desktop) : null
  const word = office?.word || samplePdf(4)
  const slides = office?.slides || samplePdf(24, 960, 540)
  const entry = path.join(root, 'fixture.jsx')
  await fs.writeFile(
    entry,
    `
    import React, {useState} from ${JSON.stringify(resolve('react'))}
    import {createRoot} from ${JSON.stringify(resolve('react-dom/client'))}
    import {FormatPreview} from ${JSON.stringify(path.join(desktop, 'src/app/chat/right-rail/formats/format-preview.tsx'))}
    import {PDF_RESOURCE_OPTIONS} from ${JSON.stringify(path.join(desktop, 'src/app/chat/right-rail/pdf-resources.ts'))}
    import ${JSON.stringify(path.join(desktop, 'src/styles.css'))}
    const files = ${JSON.stringify(['sample.pdf', 'word.docx', 'slides.pptx'].map(label => ({ kind: 'file', label, path: path.join(root, label), source: path.join(root, label), url: pathToFileURL(path.join(root, label)).href, previewKind: 'binary' })))}
    window.pdfResources=PDF_RESOURCE_OPTIONS
    // 夹具只持有选文件按钮；正式预览中心决定读取、转换、候选与显示。
    function Fixture() {
      const [index,select]=useState(0)
      return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}>
        <nav>{files.map((file,index)=><button key={file.path} onClick={()=>select(index)}>{file.label}</button>)}</nav>
        <div style={{position:'relative',flex:1,minHeight:0}}><FormatPreview reloadKey={0} target={files[index]}/></div>
      </div>
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
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
      rolldownOptions: { input: entry }
    }
  })
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'))
  const built = Object.values(manifest).find(item => item.isEntry)
  const html =
    '<!doctype html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div>'
  await fs.writeFile(
    path.join(output, 'index.html'),
    `${(built.css || []).map(file => `<link rel="stylesheet" href="./${file}">`).join('')}${html}<script type="module" src="./${built.file}"></script>`
  )
  const devEntry = path.join(root, 'dev.js')
  await fs.writeFile(
    devEntry,
    `
    import {createPdfEngine} from ${JSON.stringify(path.join(desktop, 'src/app/chat/right-rail/pdf-engine.ts'))}
    import {openPdfPages} from ${JSON.stringify(path.join(desktop, 'src/app/chat/right-rail/formats/pdf-pages.ts'))}
    window.devFailures=[]
    window.devEngine=createPdfEngine(document.getElementById('scroll'),document.getElementById('pages'),{data:Uint8Array.from(${JSON.stringify([...word])})},{onPages:count=>window.devPages=count,onError:error=>window.devFailures.push(String(error)),onFind:()=>{},onPassword:()=>{},onScale:()=>{}})
    window.devSlides=await openPdfPages(Uint8Array.from(${JSON.stringify([...slides])}))
    const image=new Image();image.src=await window.devSlides.renderPage(1);await image.decode();window.devImageWidth=image.naturalWidth;
  `
  )
  await fs.writeFile(
    path.join(root, 'dev.html'),
    `<!doctype html><base href="/"><div id="scroll" class="hermes-pdf" style="position:absolute;inset:0;overflow:auto"><div id="pages" class="pdfViewer"></div></div><script type="module" src="/@fs/${devEntry.replaceAll('\\', '/')}"></script>`
  )
  await bundle({
    entryPoints: [path.join(desktop, 'electron/preload.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: path.join(root, 'preload.cjs')
  })
  await bundle({
    stdin: {
      contents: `
    import {app,BrowserWindow,ipcMain} from 'electron'
    import {readFileDataUrlForIpc} from './electron/hardening'
    app.disableHardwareAcceleration()
    app.setPath('userData',${JSON.stringify(path.join(root, 'user-data'))})
    for(const channel of ['hermes:translucency:support','hermes:hud:windowing','hermes:feature-flags','hermes:skin:local']) ipcMain.on(channel,event=>{event.returnValue={}})
    ipcMain.handle('hermes:readFileDataUrl',(_event,file)=>readFileDataUrlForIpc(file,{purpose:'File preview',mimeType:'application/pdf',maxBytes:16*1024*1024}))
    ipcMain.handle('hermes:office-preview:convert',(_event,file)=>({ok:true,pdf:Uint8Array.from(file.endsWith('.pptx')?${JSON.stringify([...slides])}:${JSON.stringify([...word])}),converter:'fixture',version:'fixture'}))
    ipcMain.handle('hermes:office-preview:cancel',()=>{})
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1000,height:780,webPreferences:{preload:${JSON.stringify(path.join(root, 'preload.cjs'))},contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}}).loadURL('about:blank'))
    app.on('window-all-closed',()=>app.quit())
  `,
      resolveDir: desktop
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: path.join(root, 'main.cjs')
  })
  const server = await createServer({
    root: desktop,
    logLevel: 'warn',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: '127.0.0.1',
      port: 0,
      open: false,
      hmr: false,
      watch: null,
      fs: { allow: [root, path.resolve(desktop, '../..')] }
    }
  })
  let app
  const errors = []
  const workers = []
  const requests = []
  const report = []
  try {
    await server.listen()
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(root, 'main.cjs')],
      cwd: desktop,
      env
    })
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(String(error)))
    page.on('worker', worker => workers.push(worker.url()))
    page.on('request', request => requests.push(request.url()))
    await page.route('https://fonts.googleapis.com/**', route => route.abort())
    for (const [mode, url] of [['production', pathToFileURL(path.join(output, 'index.html')).href]]) {
      await page.goto(url)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
      for (const name of ['sample.pdf', 'word.docx']) {
        await page.getByRole('button', { name, exact: true }).click()
        const viewer = page.getByRole('region', { name, exact: true })
        // Office 的 tagged PDF 还包含 display:contents 的标记容器；鼠标必须选择实际文字叶节点。
        const span = viewer.locator('.textLayer span[role="presentation"]').filter({ hasText: /\S/ }).first()
        await expect(span).toBeVisible({ timeout: 30000 })
        assert.equal(await page.locator('iframe').count(), 0)
        const needle = (await span.textContent()).trim().slice(0, 4)
        await expect.poll(() => span.boundingBox()).not.toBeNull()
        const box = await span.boundingBox()
        await page.mouse.move(box.x + 1, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 })
        await page.mouse.up()
        assert.ok((await page.evaluate(() => getSelection().toString())).length > 0, '必须能用真实鼠标选择 PDF 文字')
        await viewer.getByRole('button', { name: 'Find in document', exact: true }).click()
        await viewer.getByRole('textbox', { name: 'Find in document', exact: true }).fill(needle)
        await expect.poll(() => viewer.locator('[data-pdf-matches]').textContent()).toMatch(/\d+ \/ [1-9]/)
        await viewer.getByRole('button', { name: 'Close search', exact: true }).click()
        const oldZoom = await viewer.locator('[data-pdf-zoom]').textContent()
        await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click()
        await expect.poll(() => viewer.locator('[data-pdf-zoom]').textContent()).not.toBe(oldZoom)
        await viewer.locator('[data-pdf-zoom]').click()
        const scroll = viewer.locator('.hermes-pdf')
        await scroll.evaluate(node => {
          node.scrollTop = node.scrollHeight
        })
        await expect.poll(() => viewer.locator('.page').last().getAttribute('data-loaded')).toBe('true')
        await scroll.evaluate(node => {
          node.scrollTop = 0
        })
        await expect(viewer.locator('.page').first().locator('canvas')).toBeVisible()
        assert.equal(await viewer.locator('.page').first().getAttribute('data-loaded'), 'true')
        const color = await viewer
          .locator('.page')
          .first()
          .evaluate(node => getComputedStyle(node).backgroundColor)
        assert.equal(color, 'rgb(255, 255, 255)')
        await page.screenshot({ path: path.join(root, `${mode}-${name}.png`) })
        report.push({ mode, name, needle, whitePage: color })
      }
      await page.getByRole('button', { name: 'slides.pptx', exact: true }).click()
      const first = page.locator('[data-slide="1"] img')
      await expect(first).toBeVisible()
      const list = page.locator('[data-slide="1"]').locator('..').locator('..')
      for (let number = 2; number <= 24; number++) {
        await page.locator(`[data-slide="${number}"]`).evaluate(node => node.scrollIntoView({ block: 'start' }))
        await expect(page.locator(`[data-slide="${number}"] img`)).toBeVisible()
      }
      await list.evaluate(node => {
        window.returnLoads = 0
        const first = node.querySelector('[data-slide="1"]')
        window.returnObserver = new MutationObserver(() => {
          if (first.querySelector('[role="status"]')) window.returnLoads++
        })
        window.returnObserver.observe(first, { subtree: true, childList: true })
        node.scrollTop = 0
      })
      await expect(first).toBeVisible()
      await expect.poll(() => first.evaluate(image => image.complete && image.naturalWidth)).toBe(1600)
      assert.equal(
        await page.evaluate(() => {
          window.returnObserver.disconnect()
          return window.returnLoads
        }),
        0,
        '回看缓存页不能先闪加载占位'
      )
      await page.screenshot({ path: path.join(root, `${mode}-ppt-return.png`) })
      report.push({ mode, slides: 24, returned: true })
    }
    await page.goto(`${server.resolvedUrls.local[0]}@fs/${path.join(root, 'dev.html').replaceAll('\\', '/')}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    })
    await page.waitForFunction(() => window.devPages === 4 && window.devImageWidth === 1600)
    await expect(page.locator('.textLayer span').filter({ hasText: 'StageTwo' }).first()).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.devFailures), [])
    await page.evaluate(async () => {
      await window.devSlides.dispose()
      window.devEngine.destroy()
    })
    report.push({ mode: 'dev', wordPages: 4, slideWidth: 1600 })
    assert.ok(workers.length >= 4)
    assert.ok(
      workers.every(url => /assets\/pdfjs-[^/]+\/pdf.worker.js/.test(url)),
      JSON.stringify(workers)
    )
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ report, workers }))
  } finally {
    await fs.writeFile(
      path.join(root, 'report.json'),
      JSON.stringify({ realOffice: !!office, report, workers, errors, requests }, null, 2)
    )
    await app?.close()
    await server.close()
  }
})
