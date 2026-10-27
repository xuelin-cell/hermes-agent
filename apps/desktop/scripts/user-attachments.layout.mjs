import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chromium } from '@playwright/test'
import { build, preview } from 'vite'

/** 独立浏览器检查正式聊天卡片和文件预览；读取只允许本次临时文件，不启动后端。 */
test('发送与历史重开显示文档卡片，点击预览真实临时文件', { timeout: 180_000 }, async () => {
  const desktop = path.resolve(import.meta.dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uniworker-sent-files-'))
  const file = path.join(root, '项目周报 (1).md')
  await fs.writeFile(file, '# 本周完成\n\n这是本次验收的真实文件正文。\n')
  const entry = path.join(root, 'fixture.jsx')
  const resolve = createRequire(import.meta.url).resolve
  /** 让临时入口导入正式组件，并沿用项目的 Vite 和 CSS 配置。 */
  const source = name => JSON.stringify(path.join(desktop, name))
  console.log('发送附件布局验收记录：' + root)
  await fs.writeFile(
    entry,
    `
    import React,{useState} from ${JSON.stringify(resolve('react'))}
    import {createRoot} from ${JSON.stringify(resolve('react-dom/client'))}
    import {useStore} from ${JSON.stringify(resolve('@nanostores/react'))}
    import {AssistantRuntimeProvider,useExternalStoreRuntime} from ${JSON.stringify(resolve('@assistant-ui/react'))}
    import {I18nProvider} from ${source('src/i18n/context.tsx')}
    import {Thread} from ${source('src/components/assistant-ui/thread/index.tsx')}
    import {formatRefValue} from ${source('src/components/assistant-ui/directive-text.tsx')}
    import {toChatMessages} from ${source('src/lib/chat-messages/index.ts')}
    import {toRuntimeMessage} from ${source('src/lib/chat-runtime.ts')}
    import {planEdit} from ${source('src/app/session/hooks/use-prompt-actions/rewind.ts')}
    import {LocalFilePreview} from ${source('src/app/chat/right-rail/preview-file.tsx')}
    import {$previewTabs} from ${source('src/store/preview.ts')}
    import ${source('src/styles.css')}
    const ref='@file:'+formatRefValue(${JSON.stringify(file)})
    // 只切换受控消息来源；聊天、卡片、路径解析和右侧预览均使用正式实现。
    function Fixture(){
      const [restored,setRestored]=useState(false)
      const [caption,setCaption]=useState('你好')
      const messages=restored?toChatMessages([{role:'user',content:ref+${JSON.stringify('\n\n')}+caption}]):
        [{id:'sent',role:'user',parts:[{type:'text',text:caption}],attachmentRefs:[ref]}]
      const runtime=useExternalStoreRuntime({messages:messages.map(toRuntimeMessage),isRunning:false,onNew:async()=>{},
        onEdit:async edited=>{window.lastEditedPlan=planEdit(messages,edited)}})
      const tabs=useStore($previewTabs)
      const target=tabs.at(-1)?.target
      return <I18nProvider configClient={null} initialLocale="zh"><div style={{height:'100vh',display:'flex',flexDirection:'column'}}>
        <button onClick={()=>{setRestored(true);$previewTabs.set([])}}>重开历史</button>
        <button onClick={()=>{setCaption('');$previewTabs.set([])}}>只发送文件</button>
        <div style={{flex:1,display:'flex',minHeight:0}}>
          <div data-testid="chat" style={{flex:1,minWidth:0}}><AssistantRuntimeProvider runtime={runtime}><Thread/></AssistantRuntimeProvider></div>
          <div data-testid="preview" style={{position:'relative',width:'45%',minWidth:0}}>{target&&<LocalFilePreview target={target} reloadKey={0}/>}</div>
        </div>
      </div></I18nProvider>
    }
    createRoot(document.getElementById('root')).render(<Fixture/>)
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
  await fs.writeFile(
    path.join(output, 'index.html'),
    '<!doctype html><meta charset="utf-8">' +
      (built.css || []).map(name => `<link rel="stylesheet" href="./${name}">`).join('') +
      `<body style="margin:0"><div id="root"></div><script type="module" src="./${built.file}"></script>`
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
    const page = await browser.newPage({ viewport: { width: 1100, height: 750 } })
    const errors = []
    const reads = []
    page.on('pageerror', error => errors.push(error.message))
    await page.exposeFunction('readFixtureFile', async requested => {
      assert.equal(path.resolve(requested), file)
      reads.push(requested)
      const text = await fs.readFile(file, 'utf8')
      return { path: file, text, byteSize: Buffer.byteLength(text), language: 'markdown', mimeType: 'text/markdown' }
    })
    await page.addInitScript(() => {
      window.hermesDesktop = { readFileText: window.readFixtureFile, normalizePreviewTarget: async () => null }
    })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'load' })
    for (const restored of [false, true]) {
      if (restored) await page.getByRole('button', { name: '重开历史' }).click()
      const card = page.locator('[data-slot="composer-attachments"] button')
      await card.waitFor()
      const box = await card.boundingBox()
      assert.ok(box && box.width >= 200 && box.width <= 250 && box.height >= 40)
      assert.equal(await card.locator('button').count(), 0)
      assert.equal(await page.locator('[data-slot="composer-attachments"] button').count(), 1)
      assert.equal(await card.getByText('项目周报 (1).md', { exact: true }).count(), 1)
      assert.ok(
        await card.evaluate(node => {
          const bubble = node.closest('.composer-human-message')
          return bubble && bubble.textContent.includes('你好') && !bubble.matches('button')
        })
      )
      await card.click()
      await page.locator('[data-testid="preview"]').getByRole('heading', { name: '本周完成' }).waitFor()
      await page.screenshot({ path: path.join(root, restored ? 'restored.png' : 'sent.png') })
      await page.getByRole('button', { name: '编辑消息', exact: true }).click()
      const editor = page.getByRole('textbox', { name: '编辑消息', exact: true })
      await editor.waitFor()
      assert.equal(await editor.textContent(), '你好')
      assert.equal(
        await page.locator('[data-slot="aui_edit-composer-root"] [data-slot="composer-attachments"]').count(),
        1
      )
      await editor.fill('新的消息说明')
      await editor.press('Enter')
      await page.waitForFunction(() => window.lastEditedPlan?.editedMessage?.parts?.[0]?.text === '新的消息说明')
      const plan = await page.evaluate(() => window.lastEditedPlan)
      assert.ok(plan.text.includes(file) && plan.text.endsWith('\n\n新的消息说明'))
      await page.evaluate(() => {
        window.lastEditedPlan = null
      })
    }
    await page.getByRole('button', { name: '只发送文件', exact: true }).click()
    const fileCard = page.locator('[data-slot="composer-attachments"] button')
    await fileCard.click()
    await page.locator('[data-testid="preview"]').getByRole('heading', { name: '本周完成' }).waitFor()
    assert.equal(await page.locator('[data-slot="aui_edit-composer-root"]').count(), 0)
    const edit = page.getByRole('button', { name: '编辑消息', exact: true })
    assert.equal(await fileCard.evaluate(node => node.parentElement.closest('button')), null)
    await page.screenshot({ path: path.join(root, 'file-only.png') })
    await edit.click()
    const editor = page.getByRole('textbox', { name: '编辑消息', exact: true })
    await editor.waitFor()
    await editor.press('Escape')
    await fileCard.waitFor()
    assert.ok(reads.length >= 2)
    assert.equal(await fs.readFile(file, 'utf8'), '# 本周完成\n\n这是本次验收的真实文件正文。\n')
    assert.deepEqual(errors, [])
    await fs.writeFile(path.join(root, 'receipt.json'), JSON.stringify({ file, reads, errors }, null, 2))
  } finally {
    await browser?.close()
    await new Promise((resolve, reject) => server.httpServer.close(error => (error ? reject(error) : resolve())))
  }
})
