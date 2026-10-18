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
  console.log(
    '独立本机模型夹具、原版对话和 Electron 卡片重开验收：node scripts/deliverables.native.mjs --run [--fallback | --wrapped]'
  )
  process.exit(0)
}

/** 真实对话和数据库重开产物进入正式 Markdown 文件卡片与预览，所有窗口和数据独立。 */
test('交付卡片从真实持久记录重放，关闭重开与 Renderer 重载后仍能预览原文件', { timeout: 240000 }, async () => {
  const desktop = path.resolve(import.meta.dirname, '..')
  const repo = path.resolve(desktop, '../..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hmt-delivery-native-'))
  console.log('交付物原生验收记录：' + root)
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/API_KEY|TOKEN|SECRET|PASSWORD|^HERMES_/.test(name)) delete env[name]
  }
  await promisify(execFile)(
    process.env.FIXTURE_PYTHON || path.join(repo, '.venv/Scripts/python.exe'),
    [
      path.join(
        repo,
        process.argv.includes('--fallback')
          ? 'tests/plugins/desktop_deliverables_generated_fixture.py'
          : 'tests/plugins/desktop_deliverables_fixture.py'
      ),
      path.join(root, 'conversation'),
      process.argv.includes('--wrapped') ? 'wrapped' : process.argv.includes('--fallback') ? 'fallback' : 'workspace'
    ],
    { cwd: repo, windowsHide: true, timeout: 120000, maxBuffer: 5 * 1024 * 1024, env: { ...env, PYTHONPATH: repo } }
  )
  const receipt = JSON.parse(await fs.readFile(path.join(root, 'conversation/receipt.json'), 'utf8'))
  const resolve = createRequire(import.meta.url).resolve
  const entry = path.join(root, 'fixture.jsx')
  /** 只为独立入口解析正式组件的绝对模块地址。 */
  const source = file => JSON.stringify(path.join(desktop, file))
  await fs.writeFile(
    entry,
    `
    import React, {useState} from ${JSON.stringify(resolve('react'))}
    import {createRoot} from ${JSON.stringify(resolve('react-dom/client'))}
    import {useStore} from ${JSON.stringify(resolve('@nanostores/react'))}
    import {I18nProvider} from ${source('src/i18n/context.tsx')}
    import {MessageTextContent} from ${source('src/components/assistant-ui/markdown-text.tsx')}
    import {LocalFilePreview} from ${source('src/app/chat/right-rail/preview-file.tsx')}
    import {$previewTabs} from ${source('src/store/preview.ts')}
    import ${source('src/styles.css')}
    // 只提供关开会话按钮；正文是数据库重开后的真实显示历史。
    function Fixture() {
      const [open,setOpen]=useState(true)
      const tabs=useStore($previewTabs)
      const preview=tabs.at(-1)?.target
      return <I18nProvider configClient={null} initialLocale="en"><div style={{height:'100vh',display:'flex',flexDirection:'column'}}>
        <button onClick={()=>{setOpen(!open);$previewTabs.set([])}}>{open?'Close conversation':'Reopen conversation'}</button>
        {open&&<div style={{display:'flex',flex:1,minHeight:0}}>
          <div data-testid="chat" style={{width:'50%'}}><MessageTextContent text={${JSON.stringify(receipt.text)}}/></div>
          <div data-testid="rail" style={{position:'relative',flex:1,minHeight:0}}>{preview&&<LocalFilePreview target={preview} reloadKey={0}/>}</div>
        </div>}
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
  const built = Object.values(manifest).find(file => file.isEntry)
  await fs.writeFile(
    path.join(output, 'index.html'),
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
      contents: `
    import {app,BrowserWindow,ipcMain} from 'electron'
    import fs from 'node:fs/promises'
    import {resolveReadableFileForIpc} from './electron/hardening'
    app.disableHardwareAcceleration()
    app.setPath('userData',${JSON.stringify(path.join(root, 'user-data'))})
    for(const name of ['hermes:translucency:support','hermes:hud:windowing','hermes:feature-flags','hermes:skin:local']) ipcMain.on(name,event=>{event.returnValue={}})
    ipcMain.handle('hermes:normalizePreviewTarget',()=>null)
    ipcMain.handle('hermes:fs:gitRoot',()=>null)
    ipcMain.handle('hermes:readFileText',async(_event,file)=>{
      const allowed=await resolveReadableFileForIpc(file,{purpose:'File preview',maxBytes:512*1024})
      const text=await fs.readFile(allowed.resolvedPath,'utf8')
      return {text,binary:false,language:'markdown',byteSize:Buffer.byteLength(text)}
    })
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:720,webPreferences:{preload:${JSON.stringify(path.join(root, 'preload.cjs'))},contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}}).loadURL('about:blank'))
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
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: electronPath, args: [path.join(root, 'main.cjs')], env })
  const errors = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(String(error)))
    await page.route('https://fonts.googleapis.com/**', route => route.abort())
    await page.goto(pathToFileURL(path.join(output, 'index.html')).href)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
    for (let attempt = 0; attempt < 3; attempt++) {
      // Renderer 重载会恢复预览标签；保留它，不把原版恢复行为误报成卡片消失。
      const card = page.getByTestId('chat').getByRole('button', { name: /^(Open preview|Hide)$/ })
      await expect(card).toHaveCount(1)
      await expect(page.getByTestId('chat')).toContainText(path.basename(receipt.path))
      if ((await card.textContent()) === 'Open preview') await card.click()
      await expect(page.getByTestId('rail').getByRole('heading', { name: '交付测试', exact: true })).toBeVisible()
      if (attempt === 0) {
        await page.getByRole('button', { name: 'Close conversation', exact: true }).click()
        await page.getByRole('button', { name: 'Reopen conversation', exact: true }).click()
      } else if (attempt === 1) await page.reload()
    }
    await page.screenshot({ path: path.join(root, 'replayed-card.png') })
    assert.deepEqual(errors, [])
  } finally {
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ receipt, errors }, null, 2))
    await app.close()
  }
})
