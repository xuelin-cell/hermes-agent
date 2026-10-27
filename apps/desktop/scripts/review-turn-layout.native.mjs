import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chromium } from '@playwright/test'
import { build, preview } from 'vite'

/** 用独立 Chromium 验证正式 CSS 下的 Diff 高度，不打开用户桌面或启动后端。 */
test('本轮三次编辑的代码差异有真实高度并可滚动查看', { timeout: 180_000 }, async () => {
  const desktop = path.resolve(import.meta.dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uniworker-turn-diff-'))
  const entry = path.join(root, 'fixture.tsx')
  const resolve = createRequire(import.meta.url).resolve
  console.log('布局验收记录：' + root)
  await fs.writeFile(
    entry,
    `
    import React from ${JSON.stringify(resolve('react'))}
    import {createRoot} from ${JSON.stringify(resolve('react-dom/client'))}
    import {I18nProvider} from ${JSON.stringify(path.join(desktop, 'src/i18n/context.tsx'))}
    import {ChangedFilesCard} from ${JSON.stringify(path.join(desktop, 'src/components/assistant-ui/thread/changed-files-card.tsx'))}
    import {ReviewPane} from ${JSON.stringify(path.join(desktop, 'src/app/right-sidebar/review/index.tsx'))}
    import ${JSON.stringify(path.join(desktop, 'src/styles.css'))}
    const parts = [1, 2, 3].map(index => ({type: 'tool-call', toolName: 'patch',
      args: {path: 'generate_docx.js'}, result: {success: true,
        diff: '--- a/generate_docx.js\\n+++ b/generate_docx.js\\n@@ -1 +1 @@\\n-old_step_' + index + '\\n+new_step_' + index}}))
    createRoot(document.getElementById('root')).render(
      <I18nProvider configClient={null} initialLocale="en">
        <div style={{display:'flex',height:'100vh',overflow:'hidden'}}>
          <div style={{flex:1,padding:16}}><ChangedFilesCard parts={parts}/></div>
          <div data-testid="review" style={{width:380,height:'100%',minHeight:0}}><ReviewPane/></div>
        </div>
      </I18nProvider>)
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
    '<!doctype html><html><head><meta charset="utf-8">' +
      (built.css || []).map(file => `<link rel="stylesheet" href="./${file}">`).join('') +
      '</head><body style="margin:0"><div id="root"></div>' +
      `<script type="module" src="./${built.file}"></script></body></html>`
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
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'load' })
    await page.locator('[data-slot="aui_changed-files"]').getByText('generate_docx.js').click()
    const panels = page.locator('[data-testid="review"] [data-slot="file-diff-panel"]')
    await panels.nth(2).waitFor({ state: 'attached' })
    const geometry = await panels.evaluateAll(nodes =>
      nodes.map(node => ({
        height: node.getBoundingClientRect().height,
        viewportHeight: node.firstElementChild?.getBoundingClientRect().height,
        text: node.textContent
      }))
    )
    await page.screenshot({ path: path.join(root, 'review.png') })
    await fs.writeFile(path.join(root, 'receipt.json'), JSON.stringify({ geometry, errors }, null, 2))
    assert.equal(geometry.length, 3)
    for (const [index, panel] of geometry.entries()) {
      assert.ok(panel.height > 0 && panel.viewportHeight > 0, '差异正文不能只有 DOM 文本而没有可见高度')
      assert.ok(panel.text.includes(`old_step_${index + 1}`) && panel.text.includes(`new_step_${index + 1}`))
    }
    await panels.nth(2).scrollIntoViewIfNeeded()
    assert.ok(await panels.nth(2).isVisible())
    const lastCode = panels.nth(2).getByText('new_step_3', { exact: true })
    await lastCode.scrollIntoViewIfNeeded()
    const codeBox = await lastCode.boundingBox()
    assert.ok(codeBox && codeBox.height > 0 && codeBox.y >= 0 && codeBox.y + codeBox.height <= 800)
    await page.screenshot({ path: path.join(root, 'review-last-edit.png') })
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise((resolve, reject) => server.httpServer.close(error => (error ? reject(error) : resolve())))
  }
})
