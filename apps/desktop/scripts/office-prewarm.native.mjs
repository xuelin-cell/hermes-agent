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
import { build } from 'vite'

import { realOfficePdfs } from './pdf-preview.office-fixture.mjs'

if (!process.argv.includes('--run') || !process.argv.includes('--office')) {
  console.log('仅显式授权后运行：node scripts/office-prewarm.native.mjs --run --office；使用独立样例、缓存和窗口')
  process.exit(0)
}

/** 正式卡片挂载、preload、受限 IPC、Office、缓存和预览显示器串成独立原生链路。 */
test('Word/PPT 卡片未点击即完成真实预转换，点击直接复用账号缓存', { timeout: 300000 }, async () => {
  const desktop = path.resolve(import.meta.dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-office-prewarm-'))
  console.log('Office 预准备验收记录：' + root)
  // helper 在启动前后核对无现用 Word/PPT，不借用 WPS 实例。
  await realOfficePdfs(root, desktop)
  const files = ['word.docx', 'slides.pptx'].map(name => path.join(root, name))
  const resolve = createRequire(import.meta.url).resolve
  /** 正式源码的绝对入口只用于独立构建，不写入产品。 */
  const source = file => JSON.stringify(path.join(desktop, file))
  const entry = path.join(root, 'fixture.jsx')
  await fs.writeFile(
    entry,
    `
    import React from ${JSON.stringify(resolve('react'))}
    import {createRoot} from ${JSON.stringify(resolve('react-dom/client'))}
    import {useStore} from ${JSON.stringify(resolve('@nanostores/react'))}
    import {I18nProvider} from ${source('src/i18n/context.tsx')}
    import {PreviewAttachment} from ${source('src/components/chat/preview-attachment.tsx')}
    import {FormatPreview} from ${source('src/app/chat/right-rail/formats/format-preview.tsx')}
    import {$previewTabs} from ${source('src/store/preview.ts')}
    import ${source('src/styles.css')}
    const files=${JSON.stringify(files)}
    // 独立夹具从空预览区开始，以便检查后台准备不会自行打开文件。
    $previewTabs.set([])
    // 页面只组合正式卡片和预览，不模拟准备请求。
    function Fixture(){
      const tabs=useStore($previewTabs), target=tabs.at(-1)?.target
      return <I18nProvider configClient={null} initialLocale="en"><div style={{display:'flex',height:'100vh'}}>
        <div data-testid="chat" style={{width:'40%'}}>{files.map(file=><PreviewAttachment key={file} target={file}/>)}</div>
        <div data-testid="rail" style={{position:'relative',flex:1,minHeight:0}}>{target&&<FormatPreview target={target} reloadKey={0}/>}</div>
      </div></I18nProvider>
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
    import {app,BrowserWindow,ipcMain,session} from 'electron'
    import {createOfficePreviewService} from './electron/office-preview/service'
    import {createOfficeDetector} from './electron/office-preview/detect'
    import {convertCom} from './electron/office-preview/convert-com'
    import {installOfficePreviewIpc} from './electron/office-preview/ipc'
    app.disableHardwareAcceleration()
    app.setPath('userData',${JSON.stringify(path.join(root, 'user-data'))})
    globalThis.officeProbe={calls:[],conversions:[],running:0,maxRunning:0}
    const probe=globalThis.officeProbe
    const detected=await createOfficeDetector().get()
    const programs=Object.fromEntries(Object.entries(detected).map(([kind,list])=>[kind,list.filter(program=>program.provider==='ms-office')]))
    const service=createOfficePreviewService(${JSON.stringify(path.join(root, 'ui-account'))},{
      detector:{/* 本轮只允许已核对的 MS Office。 */ get:async()=>programs,/* 固定样例无需重新探测。 */ invalidate(){}},
      // 只观测正式转换次数，不替换 COM 或文件结果。
      com:async(...args)=>{
        probe.running++;probe.maxRunning=Math.max(probe.maxRunning,probe.running)
        const item={kind:args[0].kind,done:false};probe.conversions.push(item)
        try{const result=await convertCom(...args);Object.assign(item,{done:true,ok:result.ok});return result}
        finally{probe.running--}
      }
    })
    const observed={
      // 正式服务拥有路径与账号缓存，夹具仅记录前后台请求。
      convert:async(...args)=>{
        const item={path:args[0],background:args[2]===true,done:false};probe.calls.push(item)
        const result=await service.convert(...args);Object.assign(item,{done:true,ok:result.ok});return result
      }
    }
    for(const name of ['hermes:translucency:support','hermes:hud:windowing','hermes:feature-flags','hermes:skin:local']) ipcMain.on(name,event=>{event.returnValue={}})
    ipcMain.handle('hermes:normalizePreviewTarget',()=>null)
    ipcMain.handle('hermes:fs:gitRoot',()=>null)
    app.whenReady().then(()=>{
      installOfficePreviewIpc(session.defaultSession,()=>${JSON.stringify(pathToFileURL(index).href)},()=>true,observed)
      new BrowserWindow({show:false,width:1200,height:780,webPreferences:{preload:${JSON.stringify(path.join(root, 'preload.cjs'))},contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}}).loadURL('about:blank')
    })
    app.on('window-all-closed',()=>app.quit())
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
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(String(error)))
    await page.route('https://fonts.googleapis.com/**', route => route.abort())
    await page.goto(pathToFileURL(index).href)
    await expect(page.getByTestId('chat').getByRole('button', { name: 'Open preview', exact: true })).toHaveCount(2)
    await expect
      .poll(
        () =>
          app.evaluate(
            () => globalThis.officeProbe.calls.filter(item => item.background && item.done && item.ok).length
          ),
        { timeout: 180000 }
      )
      .toBe(2)
    assert.equal(await page.getByTestId('rail').textContent(), '')
    assert.equal(await app.evaluate(() => globalThis.officeProbe.maxRunning), 1)
    // 点击前的检查保持隐藏，避免人工点击与“后台不自动开面板”的断言互相干扰。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
    for (const name of ['word.docx', 'slides.pptx']) {
      const card = page.getByText(name, { exact: true }).locator('..')
      await card.getByRole('button', { name: 'Open preview', exact: true }).click()
      const rail = page.getByTestId('rail')
      if (name === 'word.docx')
        await expect(rail.locator('.textLayer span[role="presentation"]').first()).toBeVisible({ timeout: 30000 })
      else await expect(rail.locator('[data-slide="1"] img')).toBeVisible({ timeout: 30000 })
      assert.equal(await app.evaluate(() => globalThis.officeProbe.conversions.length), 2)
      await page.screenshot({ path: path.join(root, name + '.png') })
    }
    assert.deepEqual(errors, [])
  } finally {
    const probe = await app.evaluate(() => globalThis.officeProbe)
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ errors, probe }, null, 2))
    await app.close()
  }
})
