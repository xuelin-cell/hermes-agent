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
    import {AssistantRuntimeProvider,ThreadPrimitive,useExternalStoreRuntime} from ${JSON.stringify(resolve('@assistant-ui/react'))}
    import {AssistantPublishedArtifacts} from ${source('src/components/artifact-share/published-artifacts.tsx')}
    import {ShareControls} from ${source('src/components/artifact-share/share-controls.tsx')}
    import {ConversationShareDialog} from ${source('src/components/conversation-share/dialog.tsx')}
    import {ConversationSessionShareButton} from ${source('src/components/conversation-share/session-button.tsx')}
    import {TreeGroup} from ${source('src/components/pane-shell/tree/renderer/tree-group.tsx')}
    import {registry} from ${source('src/contrib/registry.ts')}
    import {setSessionOwnerHint} from ${source('src/store/session.ts')}
    import {$conversationShareTarget} from ${source('src/store/conversation-share.ts')}
    import ${source('src/styles.css')}
    // 测试按钮只选择目标，内容读取、工具栏和文件卡片均使用正式组件。
    window.fixtureShare=scope=>$conversationShareTarget.set({owner:{profile:'fixture'},request:{sessionId:'fixture',scope,...(scope==='response'?{responseRowId:42}:{})}})
    setSessionOwnerHint('fixture',{connectionId:'local',profile:'fixture'})
    window.fixtureTarget=()=>$conversationShareTarget.get()
    registry.register({id:'session-header-fixture',area:'panes',title:'Session header fixture',data:{placement:'main',headerActions:()=> <ConversationSessionShareButton sessionId="fixture"/>},render:()=> <div/>})
    const shareMessages=[{id:'artifact-reply',role:'assistant',content:[{type:'tool-call',toolCallId:'publish',toolName:'publish_artifact',args:{path:'report.md'},argsText:'',result:{share_id:'native-artifact-share-1234',url:'https://ignored.example'}}],status:{type:'complete',reason:'stop'},createdAt:new Date(),metadata:{unstable_state:null,unstable_annotations:[],unstable_data:[],steps:[],custom:{}}}]
    function PublishedFixture(){
      const runtime=useExternalStoreRuntime({messages:shareMessages,isRunning:false,onNew:async()=>{}})
      return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root><ThreadPrimitive.Messages components={{AssistantMessage:AssistantPublishedArtifacts}}/></ThreadPrimitive.Root></AssistantRuntimeProvider>
    }
    function Fixture(){
      const [showArtifact,setShowArtifact]=useState(false);window.fixtureArtifact=()=>setShowArtifact(true)
      const [file,setFile]=useState(${JSON.stringify(md)}); window.fixtureOpen=setFile
      const target={kind:'file',source:file,path:file,label:file.split(/[/\\\\]/).at(-1),url:'file://'+file,previewKind:file.endsWith('.svg')?'image':file.endsWith('.pdf')?'pdf':'text'}
      return <I18nProvider configClient={null} initialLocale="en"><MemoryRouter><div style={{display:'flex',height:'100vh'}}>
        <aside style={{width:340,flexShrink:0}}><div style={{height:80,position:'relative'}}><TreeGroup node={{type:'group',id:'header-zone',active:'session-header-fixture',panes:['session-header-fixture'],tabStrip:'always'}} topEdge/></div><button onClick={()=>setFile(${JSON.stringify(md)})}>Markdown fixture</button><button onClick={()=>setFile(${JSON.stringify(svg)})}>SVG fixture</button><ShareControls artifactKey="fixture-share" html="<h1>Preview export</h1>" title="report.md" source={{sessionId:'fixture',content:'<h1>Preview export</h1>'}}/><PreviewAttachment target=${JSON.stringify(pdf)}/><MaasAccountSidebar/>{showArtifact&&<PublishedFixture/>}</aside>
        <main style={{position:'relative',flex:1,minHeight:0,minWidth:0}}><FormatPreview key={file} reloadKey={0} target={target}/></main><ConversationShareDialog/>
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
    import {createHash} from 'node:crypto'
    import {app,BrowserWindow,ipcMain,session,dialog,clipboard} from 'electron'
    import {installPreviewExportIpc,previewPdf} from './electron/preview-export'
    import {resolveReadableFileForIpc,readFileDataUrlForIpc} from './electron/hardening'
    app.disableHardwareAcceleration();app.setPath('userData',${JSON.stringify(path.join(root, 'user-data'))})
    app.on('window-all-closed',()=>{}) // 样例打印窗结束后继续创建测试主窗，由夹具统一关闭进程。
    globalThis.saved=[]
    globalThis.fixtureLogouts=0
    globalThis.shareRecord=null;globalThis.sharePublications=0;globalThis.shareRevocations=0
    // 分享仅替换为本机响应，弹窗与 preload 仍走正式组件，绝不上传测试内容。
    ipcMain.handle('hermes:artifact-share:eligibility',()=>({publishable:true}))
    ipcMain.handle('hermes:artifact-share:inspect',()=>globalThis.shareRecord)
    ipcMain.handle('hermes:artifact-share:publish',(_event,input)=>{globalThis.sharePublications++;return globalThis.shareRecord={key:input.key,shareId:'fixture',title:input.title,expiresAt:new Date(Date.now()+(input.ttlDays??1)*86400000).toISOString(),url:'https://share.example.test/fixture',hash:createHash('sha256').update(input.html).digest('hex'),version:1}})
    ipcMain.handle('hermes:artifact-share:expiration',(_event,key,shareId,days)=>{
      if(globalThis.expiryFails)throw new Error('expiry save failed')
      if(!globalThis.shareRecord||globalThis.shareRecord.key!==key||globalThis.shareRecord.shareId!==shareId)throw new Error('share changed')
      globalThis.shareRecord={...globalThis.shareRecord,expiresAt:new Date(Date.now()+days*86400000).toISOString()}
      for(const window of BrowserWindow.getAllWindows())window.webContents.send('hermes:artifact-share:changed',key)
      return globalThis.shareRecord
    })
    ipcMain.handle('hermes:artifact-share:revoke',()=>{globalThis.shareRevocations++;globalThis.shareRecord=null})
    globalThis.conversationRecords=[];globalThis.conversationPublications=0;globalThis.conversationRevocations=0
    const documents=new Map()
    ipcMain.handle('hermes:conversation-share:prepare',(_event,owner,request)=>{
      const document={schemaVersion:1,snapshotId:request.scope+'-'+request.includeProcess,scope:request.scope,title:'Design review',locale:'en',theme:'light',rendererVersion:1,messages:[{role:'user',blocks:[{type:'markdown',text:'Please review the **sharing flow**.'}]},{role:'assistant',blocks:[{type:'markdown',text:'## Review complete\\n\\nThe public page is a read-only snapshot.\\n\\n- Preview the content\\n- Create the link\\n- Copy or revoke it'}]}]}
      const ticket=document.snapshotId;documents.set(ticket,{document,owner,request});return {ticket,document}
    })
    ipcMain.handle('hermes:conversation-share:cancel',()=>{})
    ipcMain.handle('hermes:conversation-share:list',()=>globalThis.conversationRecords)
    ipcMain.handle('hermes:conversation-share:publish',(_event,ticket)=>{
      const {document,owner,request}=documents.get(ticket);globalThis.conversationPublications++
      const record={key:ticket,shareId:ticket,snapshotId:document.snapshotId,scope:request.scope,title:document.title,createdAt:new Date().toISOString(),state:'published',url:'https://share.example.test/'+ticket,owner,sessionId:request.sessionId}
      globalThis.conversationRecords=[record,...globalThis.conversationRecords.filter(item=>item.key!==ticket)];return record
    })
    ipcMain.handle('hermes:conversation-share:revoke',(_event,key)=>{globalThis.conversationRevocations++;globalThis.conversationRecords=globalThis.conversationRecords.map(item=>item.key===key?{...item,state:'revoked'}:item)})
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
    const headerShare = page
      .locator('[data-zone-tabstrip="header-zone"]')
      .getByRole('button', { name: 'Share conversation', exact: true })
    await expect(headerShare).toBeVisible()
    assert.equal(await headerShare.evaluate(node => node.closest('[role="tablist"]')), null)
    await headerShare.click()
    assert.ok(await page.evaluate(() => window.fixtureTarget()), '顶部分享应设置对话目标')
    const headerDialog = page.getByRole('dialog', { name: 'Share conversation', exact: true })
    await expect(headerDialog.getByRole('button', { name: 'Create public link' })).toBeEnabled()
    assert.equal(await app.evaluate(() => globalThis.conversationPublications), 0)
    await page.screenshot({ path: path.join(root, 'session-header-share.png') })
    await headerDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    for (const [scope, name] of [
      ['session', 'Share conversation'],
      ['response', 'Share response']
    ]) {
      await page.evaluate(scope => window.fixtureShare(scope), scope)
      const dialog = page.getByRole('dialog', { name, exact: true })
      await expect(dialog.getByRole('button', { name: 'Create public link' })).toBeEnabled({ timeout: 30000 })
      const count = scope === 'session' ? 0 : 1
      assert.equal(await app.evaluate(() => globalThis.conversationPublications), count)
      await page.screenshot({ path: path.join(root, scope + '-share-preview.png') })
      await dialog.getByRole('button', { name: 'Create public link' }).click()
      await expect(dialog.getByRole('button', { name: 'Copy share link', exact: true })).toBeVisible()
      await page.screenshot({ path: path.join(root, scope + '-share-link.png') })
      await dialog.getByRole('button', { name: 'Copy share link', exact: true }).click()
      assert.equal(
        await app.evaluate(({ clipboard }) => clipboard.readText()),
        'https://share.example.test/' + scope + '-false'
      )
      await dialog.getByRole('button', { name: 'Revoke share', exact: true }).click()
      assert.equal(await app.evaluate(() => globalThis.conversationRevocations), count)
      await dialog.getByRole('button', { name: 'Revoke share', exact: true }).click()
      await expect(dialog.getByRole('button', { name: 'Create public link' })).toBeEnabled()
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    }
    // 超过 data URL 的长度限制，但仍小于 IPC 内容上限；经过正式快照和保存接口导出。
    await page.addStyleTag({ content: ':root{--snapshot-padding:"' + 'x'.repeat(3 * 1024 * 1024) + '"}' })
    await page.getByRole('button', { name: 'Share artifact', exact: true }).click()
    const share = page.getByRole('dialog', { name: 'Share artifact' })
    await expect(share.getByRole('button', { name: 'Create public link' })).toBeEnabled()
    assert.equal(await app.evaluate(() => globalThis.sharePublications), 0)
    await page.screenshot({ path: path.join(root, 'share-confirm.png') })
    await share.getByRole('combobox',{name:'Link lifetime'}).click()
    await page.getByRole('option',{name:'3 days',exact:true}).click()
    await share.getByRole('button', { name: 'Create public link' }).click()
    await expect(share.getByRole('button', { name: 'Copy shared link' })).toBeVisible()
    await page.screenshot({ path: path.join(root, 'share-link.png') })
    assert.ok(await app.evaluate(()=>Date.parse(globalThis.shareRecord.expiresAt)-Date.now())>2.9*86400000)
    await share.getByRole('button',{name:'Change lifetime'}).click()
    const expiryDialog=page.getByRole('dialog',{name:'Change lifetime'})
    await expiryDialog.getByRole('combobox',{name:'Link lifetime'}).click()
    await page.getByRole('option',{name:'Custom days',exact:true}).click()
    await expiryDialog.getByRole('spinbutton',{name:'Custom days'}).fill('8')
    await expect(expiryDialog.getByRole('button',{name:'Save lifetime'})).toBeDisabled()
    await expiryDialog.getByRole('spinbutton',{name:'Custom days'}).fill('2')
    await app.evaluate(()=>{globalThis.expiryFails=true})
    await expiryDialog.getByRole('button',{name:'Save lifetime'}).click()
    await expect(expiryDialog.getByRole('alert')).toContainText('expiry save failed')
    await app.evaluate(()=>{globalThis.expiryFails=false})
    await page.screenshot({path:path.join(root,'share-expiry.png')})
    await expiryDialog.getByRole('button',{name:'Save lifetime'}).click()
    await expect(expiryDialog).toHaveCount(0)
    assert.ok(await app.evaluate(()=>Date.parse(globalThis.shareRecord.expiresAt)-Date.now())>1.9*86400000)
    assert.equal(await app.evaluate(()=>globalThis.sharePublications),1)
    await expect(share.getByRole('button',{name:'Copy shared link'})).toBeEnabled()
    await share.getByRole('button', { name: 'Revoke shared link' }).click()
    assert.equal(await app.evaluate(() => globalThis.shareRevocations), 0)
    await share.getByRole('button', { name: 'Revoke shared link' }).click()
    await expect(share.getByRole('button', { name: 'Create public link' })).toBeEnabled()
    assert.equal(await app.evaluate(() => globalThis.sharePublications), 1)
    assert.equal(await app.evaluate(() => globalThis.shareRevocations), 1)
    await share.getByRole('button', { name: 'Cancel' }).click()
    await expect(share).toHaveCount(0)
    await app.evaluate(() => {globalThis.shareRecord={key:'fixture-share',shareId:'native-artifact-share-1234',title:'report.md',url:'https://share.example.test/native-artifact',version:1,hash:'snapshot'}})
    await page.evaluate(() => window.fixtureArtifact())
    const artifactCard=page.getByRole('region',{name:'Share artifact'})
    await expect(artifactCard.getByText('report.md',{exact:true})).toBeVisible()
    await artifactCard.getByRole('button',{name:'Copy shared link'}).click()
    assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),'https://share.example.test/native-artifact')
    await page.screenshot({path:path.join(root,'chat-artifact-share.png')})
    await artifactCard.getByRole('button',{name:'Revoke shared link'}).click()
    const revokeArtifact=page.getByRole('dialog',{name:'Revoke shared link'})
    assert.equal(await app.evaluate(()=>globalThis.shareRevocations),1)
    await revokeArtifact.getByRole('button',{name:'Revoke shared link'}).click()
    await expect(artifactCard.getByText('Sharing was revoked or this link is no longer available.')).toBeVisible()
    assert.equal(await app.evaluate(()=>globalThis.shareRevocations),2)
    await expect(revokeArtifact).toHaveCount(0)
    await app.evaluate(({BrowserWindow})=>{
      globalThis.shareRecord={key:'fixture-share',shareId:'native-artifact-share-1234',title:'report.md',url:'https://share.example.test/native-artifact',version:1,hash:'snapshot',expiresAt:new Date(Date.now()-1000).toISOString()}
      for(const window of BrowserWindow.getAllWindows())window.webContents.send('hermes:artifact-share:changed','fixture-share')
    })
    await expect(artifactCard.getByText('Expired; cleanup is pending. The public link may still be accessible.')).toBeVisible()
    await expect(artifactCard.getByRole('button',{name:'Copy shared link'})).toHaveCount(0)
    await page.screenshot({path:path.join(root,'chat-artifact-expired.png')})
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
