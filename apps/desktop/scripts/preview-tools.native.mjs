import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { _electron as electron, expect } from '@playwright/test'
import { build as bundle } from 'esbuild'
import electronPath from 'electron'
import { build } from 'vite'

if (!process.argv.includes('--run')) {
  console.log('独立预览验收：node scripts/preview-tools.native.mjs --run [--office]；只有 --office 才启动本机 Word')
  process.exit(0)
}

/** 正式组件与原生导出串联；只控制保存位置，不操作用户文档或窗口。 */
test('Markdown 三种另存为、全文复制、SVG 切换和 PDF 文件卡片', { timeout: 240000 }, async () => {
  const desktop = path.resolve(import.meta.dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-preview-tools-'))
  console.log('阶段六原生记录：' + root)
  /** 独立构建只引用当前仓库的正式源码。 */
  const source = file => JSON.stringify(path.join(desktop, file))
  const resolve = createRequire(import.meta.url).resolve
  const markdown = '# Preview export\n\n中文导出验收\n\n| Name | Value |\n| --- | --- |\n| table | 42 |\n'
  const md = path.join(root, 'report.md'),
    svg = path.join(root, 'chart.svg'),
    pdf = path.join(root, 'sample.pdf')
  await fs.writeFile(md, markdown)
  await fs.writeFile(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="coral"/><text x="25" y="80">SVG preview</text></svg>'
  )
  const entry = path.join(root, 'fixture.jsx')
  await fs.writeFile(
    entry,
    `
    import React,{useState} from ${JSON.stringify(resolve('react'))}
    import {createRoot} from ${JSON.stringify(resolve('react-dom/client'))}
    import {I18nProvider} from ${source('src/i18n/context.tsx')}
    import {MemoryRouter} from ${JSON.stringify(resolve('react-router'))}
    import {MaasAccountSidebar} from ${source('src/app/shell/maas-account-status.tsx')}
    import {FormatPreview} from ${source('src/app/chat/right-rail/formats/format-preview.tsx')}
    import {PreviewAttachment} from ${source('src/components/chat/preview-attachment.tsx')}
    import ${source('src/styles.css')}
    // 测试按钮只选择目标，内容读取、工具栏和文件卡片均使用正式组件。
    function Fixture(){
      const [file,setFile]=useState(${JSON.stringify(md)}); window.fixtureOpen=setFile
      const target={kind:'file',source:file,path:file,label:file.split(/[/\\\\]/).at(-1),url:'file://'+file,previewKind:file.endsWith('.svg')?'image':file.endsWith('.pdf')?'pdf':'text'}
      return <I18nProvider configClient={null} initialLocale="en"><MemoryRouter><div style={{display:'flex',height:'100vh'}}>
        <aside style={{width:340,flexShrink:0}}><button onClick={()=>setFile(${JSON.stringify(md)})}>Markdown fixture</button><button onClick={()=>setFile(${JSON.stringify(svg)})}>SVG fixture</button><PreviewAttachment target=${JSON.stringify(pdf)}/><MaasAccountSidebar/></aside>
        <main style={{position:'relative',flex:1,minHeight:0,minWidth:0}}><FormatPreview key={file} reloadKey={0} target={target}/></main>
      </div></MemoryRouter></I18nProvider>
    }createRoot(document.getElementById('root')).render(<Fixture/>);
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
  const index = path.join(output, 'index.html')
  await fs.writeFile(
    index,
    '<!doctype html><meta charset="utf-8">' +
      (built.css || []).map(file => `<link rel="stylesheet" href="./${file}">`).join('') +
      `<div id="root"></div><script type="module" src="./${built.file}"></script>`
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
      resolveDir: desktop,
      contents: `
    import fs from 'node:fs/promises'
    import {app,BrowserWindow,ipcMain,session,dialog,clipboard} from 'electron'
    import {installPreviewExportIpc,previewPdf} from './electron/preview-export'
    import {resolveReadableFileForIpc,readFileDataUrlForIpc} from './electron/hardening'
    app.disableHardwareAcceleration();app.setPath('userData',${JSON.stringify(path.join(root, 'user-data'))})
    app.on('window-all-closed',()=>{}) // 样例打印窗结束后继续创建测试主窗，由夹具统一关闭进程。
    globalThis.saved=[]
    globalThis.fixtureLogouts=0
    const fixtureAccount={maskedPhone:'138****0000',expiresAt:Date.now()-1000}
    ipcMain.handle('hermes:maas-account:get',()=>fixtureAccount)
    ipcMain.handle('hermes:maas-account:usage',()=>({status:'failed'}))
    ipcMain.handle('hermes:maas-account:logout',()=>{globalThis.fixtureLogouts++})
    // 仅保存框响应受控；文件写入、PDF 打印和 Word 归档执行生产实现。
    dialog.showSaveDialog=async(_window,options)=>{const filePath=${JSON.stringify(root)}+'/saved.'+options.filters[0].extensions[0];globalThis.saved.push(filePath);return {canceled:false,filePath}}
    for(const name of ['hermes:translucency:support','hermes:hud:windowing','hermes:feature-flags','hermes:skin:local'])ipcMain.on(name,event=>{event.returnValue={}})
    ipcMain.handle('hermes:normalizePreviewTarget',()=>null);ipcMain.handle('hermes:fs:gitRoot',()=>null)
    ipcMain.handle('hermes:readFileText',async(_event,file)=>{const source=await resolveReadableFileForIpc(file,{purpose:'File preview',maxBytes:1024*1024});return {text:await fs.readFile(source.realPath,'utf8'),language:file.endsWith('.md')?'markdown':'xml'}})
    ipcMain.handle('hermes:readFileDataUrl',(_event,file)=>readFileDataUrlForIpc(file,{purpose:'File preview',mimeType:'application/pdf',maxBytes:16*1024*1024}))
    ipcMain.handle('hermes:writeClipboard',(_event,text)=>clipboard.writeText(text))
    app.whenReady().then(async()=>{
      await fs.writeFile(${JSON.stringify(pdf)},await previewPdf('<h1>Thumbnail sample</h1>'))
      installPreviewExportIpc(session.defaultSession,()=>${JSON.stringify(pathToFileURL(index).href)},()=>true)
      const window=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{preload:${JSON.stringify(path.join(root, 'preload.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
      await window.loadURL(${JSON.stringify(pathToFileURL(index).href)});window.showInactive()
    })
  `
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['electron'],
    outfile: path.join(root, 'main.mjs')
  })
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|^HERMES_/.test(name)) delete env[name]
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: electronPath, args: [path.join(root, 'main.mjs')], env })
  const errors = []
  try {
    await expect
      .poll(() => app.windows().some(page => page.url() === pathToFileURL(index).href), { timeout: 30000 })
      .toBe(true)
    const page = app.windows().find(page => page.url() === pathToFileURL(index).href)
    page.on('pageerror', error => errors.push(String(error)))
    // 超过 data URL 的长度限制，但仍小于 IPC 内容上限；经过正式快照和保存接口导出。
    await page.addStyleTag({ content: ':root{--snapshot-padding:"' + 'x'.repeat(3 * 1024 * 1024) + '"}' })
    await expect(page.getByText('sample.pdf', { exact: true })).toBeVisible({ timeout: 30000 })
    await expect(page.getByRole('img', { name: 'sample.pdf' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Copy full text' }).click()
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), markdown)
    for (const [format, label] of [
      ['md', 'Markdown (.md)'],
      ['pdf', 'PDF (.pdf)'],
      ['docx', 'Word (.docx)']
    ]) {
      await page.getByRole('button', { name: 'Save as' }).click()
      await page.getByRole('menuitem', { name: label, exact: true }).click()
      await expect
        .poll(
          () =>
            fs
              .stat(path.join(root, 'saved.' + format))
              .then(stat => stat.size)
              .catch(() => 0),
          { timeout: 30000 }
        )
        .toBeGreaterThan(0)
      await expect(page.getByRole('button', { name: 'Save as' })).toBeEnabled()
    }
    assert.equal(await fs.readFile(path.join(root, 'saved.md'), 'utf8'), markdown)
    await page.screenshot({ path: path.join(root, 'markdown-and-card.png') })
    await page.getByRole('button', { name: 'SVG fixture' }).click()
    await expect(page.getByRole('img', { name: 'chart.svg' })).toBeVisible()
    await page.getByRole('button', { name: 'SOURCE', exact: true }).click()
    await expect(page.locator('main img')).toHaveCount(0)
    await page.screenshot({ path: path.join(root, 'svg-source.png') })
    await page.getByRole('button', { name: 'PREVIEW', exact: true }).click()
    await page.screenshot({ path: path.join(root, 'svg-image.png') })
    if (process.argv.includes('--office')) {
      const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
      /** 只读核对现用 Word；存在用户实例就停止真实验证。 */
      async function activeOffice() {
        const { stdout } = await promisify(execFile)(
          powershell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '@(Get-Process WINWORD,POWERPNT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress'
          ],
          { windowsHide: true }
        )
        return stdout.trim() ? JSON.parse(stdout) : []
      }
      assert.deepEqual(await activeOffice(), [])
      const runtime = path.join(root, 'office.mjs')
      await bundle({
        stdin: {
          resolveDir: desktop,
          contents:
            "export {createOfficePreviewService} from './electron/office-preview/service';export {createOfficeDetector} from './electron/office-preview/detect'"
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: runtime
      })
      const { createOfficePreviewService, createOfficeDetector } = await import(pathToFileURL(runtime).href)
      const detected = await createOfficeDetector().get()
      const programs = Object.fromEntries(
        Object.entries(detected).map(([kind, list]) => [kind, list.filter(program => program.provider === 'ms-office')])
      )
      assert.ok(programs.word.length, '没有 MS Office，不能冒充真实 Word 验收通过')
      const service = createOfficePreviewService(path.join(root, 'office-account'), {
        detector: { get: async () => programs, /** 固定本轮探测，禁止借用其它厂家。 */ invalidate() {} }
      })
      const result = await service.convert(path.join(root, 'saved.docx'))
      assert.equal(result.ok, true, JSON.stringify(result))
      const converted = path.join(root, 'word-export.pdf')
      await fs.writeFile(converted, result.pdf)
      assert.deepEqual(await activeOffice(), [])
      await page.evaluate(file => globalThis.fixtureOpen(file), converted)
      await expect(page.locator('main .textLayer')).toContainText('Preview export', { timeout: 30000 })
      await page.screenshot({ path: path.join(root, 'word-reopened.png') })
    }
    await page.evaluate(file => globalThis.fixtureOpen(file), path.join(root, 'saved.pdf'))
    await expect(page.locator('main .textLayer')).toContainText('Preview export', { timeout: 30000 })
    await page.screenshot({ path: path.join(root, 'exported-pdf.png') })
    const account = page.locator('[data-slot=sidebar-account-trigger]')
    await expect(account).toContainText('138****0000')
    await expect(account).toContainText(/expired/i)
    await account.click()
    await page.locator('.account-card .account-card-logout').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click()
    assert.equal(await app.evaluate(() => globalThis.fixtureLogouts), 1)
    assert.deepEqual(errors, [])
  } finally {
    await fs.writeFile(
      path.join(root, 'report.json'),
      JSON.stringify(
        {
          errors,
          saved: await app.evaluate(() => globalThis.saved).catch(() => []),
          logouts: await app.evaluate(() => globalThis.fixtureLogouts).catch(() => 0)
        },
        null,
        2
      )
    )
    await app.close()
  }
})
