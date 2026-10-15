import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import electronPath from 'electron'

const desktop = path.resolve(import.meta.dirname, '..')

/** 隐藏隔离窗口经过正式 preload／IPC／缓存，只替换软件转换器，不启动 Office。 */
test('P07 页面通过正式桥接取得 PDF，第二次调用不重复转换', { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-office-service-native-'))
  const source = path.join(root, "中文 '样例'.docx")
  const pageFile = path.join(root, 'index.html')
  await fs.writeFile(source, 'controlled source')
  await fs.writeFile(pageFile, '<!doctype html><meta charset="utf-8"><title>独立预览服务验证</title>')
  const pageUrl = pathToFileURL(pageFile).href
  await build({ entryPoints: [path.join(desktop, 'electron/preload.ts')], bundle: true, platform: 'node',
    format: 'cjs', external: ['electron'], outfile: path.join(root, 'preload.cjs') })
  await build({ stdin: { contents: `
    import { app, BrowserWindow, ipcMain, session } from 'electron'
    import fs from 'node:fs/promises'
    import path from 'node:path'
    import { installOfficePreviewIpc } from './electron/office-preview/ipc'
    import { createOfficePreviewService } from './electron/office-preview/service'
    app.disableHardwareAcceleration()
    app.setPath('userData', ${JSON.stringify(path.join(root, 'user-data'))})
    for (const channel of ['hermes:translucency:support','hermes:hud:windowing','hermes:hud:drag-capability','hermes:feature-flags','hermes:skin:local']) {
      ipcMain.on(channel, event => { event.returnValue = {} })
    }
    globalThis.officeCalls = 0
    app.whenReady().then(() => {
      const accountSession = session.fromPartition('persist:office-service-fixture')
      const program = {kind:'word',provider:'ms-office',executable:'controlled',registryView:'64',progId:'Word.Application',command:''}
      const service = createOfficePreviewService(${JSON.stringify(path.join(root, 'account-A'))}, {
        detector:{get:async()=>({word:[program],slides:[],sheet:[]}),invalidate:()=>{}},
        com:async (_program,copy,directory) => {
          if (path.basename(copy)!=='source.docx') throw Error('Unexpected source copy')
          globalThis.officeCalls++
          const pdfPath=path.join(directory,'result.pdf')
          await fs.writeFile(pdfPath,'%PDF-1.7\\ncontrolled IPC fixture\\n%%EOF')
          return {ok:true,pdfPath}
        }
      })
      installOfficePreviewIpc(accountSession,()=>${JSON.stringify(pageUrl)},()=>true,service)
      const window = new BrowserWindow({show:false,webPreferences:{session:accountSession,preload:${JSON.stringify(path.join(root, 'preload.cjs'))},contextIsolation:true,sandbox:true,nodeIntegration:false}})
      window.loadURL(${JSON.stringify(pageUrl)})
    })
    app.on('window-all-closed',()=>app.quit())
  `, resolveDir: desktop, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], outfile: path.join(root, 'main.cjs') })
  const env = { ...process.env, HERMES_HOME: path.join(root, 'unused-home') }
  delete env.ELECTRON_RUN_AS_NODE
  let instance
  try {
    instance = await electron.launch({ executablePath: electronPath, args: [path.join(root, 'main.cjs')], cwd: desktop, env })
    const page = await instance.firstWindow()
    await page.waitForFunction(() => typeof window.hermesDesktop?.convertOfficePreview === 'function')
    const result = await page.evaluate(async file => {
      const first = await window.hermesDesktop.convertOfficePreview(file)
      const second = await window.hermesDesktop.convertOfficePreview(file)
      return { first, second, header: first.ok ? new TextDecoder().decode(first.pdf.slice(0, 5)) : null,
        pdfIsBytes: first.ok && first.pdf instanceof Uint8Array }
    }, source)
    assert.equal(result.first.ok, true)
    assert.deepEqual(result.first, result.second)
    assert.equal(result.header, '%PDF-')
    assert.equal(result.pdfIsBytes, true)
    assert.equal(await instance.evaluate(() => globalThis.officeCalls), 1)
    assert.deepEqual(Object.keys(result.first).sort(), ['converter','ok','pdf','version'])
    assert.equal(await fs.readFile(source, 'utf8'), 'controlled source')
    console.log('P07 独立页面／preload／IPC／文件缓存通过：' + root)
  } finally {
    await instance?.close()
  }
})
