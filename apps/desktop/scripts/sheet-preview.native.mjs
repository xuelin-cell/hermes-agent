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
import { utils, write } from 'xlsx'

import { createStyledWorkbook } from './sheet-styles.fixture.ts'
import { createImageWorkbook } from './sheet-images.fixture.ts'

if (!process.argv.includes('--run')) {
  console.log('独立隐藏窗口检查，不启动 Hermes 或 Office：node scripts/sheet-preview.native.mjs --run')
  process.exit(0)
}

const desktop = path.resolve(import.meta.dirname, '..')
const resolve = createRequire(import.meta.url).resolve

/** 正式来源、解析与界面经生产构建后在真实 Electron 中执行，不启动 Office。 */
test('P12～P14 三种工作簿、样式及内嵌图片经正式显示器呈现', { timeout: 90000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-sheet-preview-'))
  console.log('表格兼容性记录：' + root)
  const entry = path.join(root, 'fixture.js')
  const book = utils.book_new()
  const sheet = utils.aoa_to_sheet(Array.from({ length: 503 }, (_, row) => [row ? row : '中文数据', row + 0.25]))
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]
  sheet['!cols'] = [{ wpx: 150 }, { wpx: 100 }]
  utils.book_append_sheet(book, sheet, '明细')
  utils.book_append_sheet(book, utils.aoa_to_sheet([['第二表内容', 7]]), '汇总')
  const files = {}
  for (const [extension, bookType] of [['xlsx', 'xlsx'], ['xls', 'biff8'], ['ods', 'ods']]) {
    const bytes = extension === 'xlsx' ? Buffer.from(createImageWorkbook(createStyledWorkbook())) : write(book, { bookType, type: 'buffer' })
    await fs.writeFile(path.join(root, `中文样例.${extension}`), bytes)
    files[extension] = `data:application/octet-stream;base64,${bytes.toString('base64')}`
  }
  await fs.writeFile(entry, `
    import React from ${JSON.stringify(resolve('react'))}
    import { createRoot } from ${JSON.stringify(resolve('react-dom/client'))}
    import SheetPreview from ${JSON.stringify(path.join(desktop, 'src/app/chat/right-rail/formats/sheet-preview.tsx'))}
    import ${JSON.stringify(path.join(desktop, 'src/styles.css'))}
    const files = ${JSON.stringify(files)}
    window.reads = []
    window.failures = []
    window.painted = []
    window.stylePaints = []
    window.backgrounds = new Set()
    window.strokes = new Set()
    // 仅替换读取桥接，正式来源模块仍负责字节解码与错误边界。
    window.hermesDesktop = {readFileDataUrl: async path => {
      window.reads.push(path)
      return files[path.split('.').at(-1)]
    }}
    const original = CanvasRenderingContext2D.prototype.fillText
    // 记录真实画布的绘制文字，不用 API 中有数据代替已经画出来。
    CanvasRenderingContext2D.prototype.fillText = function(...args) {
      window.painted.push(String(args[0]))
      window.stylePaints.push({text:String(args[0]),font:this.font,color:this.fillStyle,x:args[1],y:args[2]})
      return original.apply(this,args)
    }
    const fillRect = CanvasRenderingContext2D.prototype.fillRect
    // 捕获真正交给画布的背景和边框，不用数据模型代替渲染证据。
    CanvasRenderingContext2D.prototype.fillRect = function(...args) {
      window.backgrounds.add(this.fillStyle)
      return fillRect.apply(this,args)
    }
    const stroke = CanvasRenderingContext2D.prototype.stroke
    CanvasRenderingContext2D.prototype.stroke = function(...args) {
      window.strokes.add(this.strokeStyle)
      return stroke.apply(this,args)
    }
    const root = createRoot(document.getElementById('root'))
    // 仅夹具持有切换入口，产品不暴露测试专用能力。
    window.loadSheet = extension => {
      window.painted = []
      window.stylePaints = []
      window.backgrounds.clear()
      window.strokes.clear()
      document.getElementById('root').style.width = '100%'
      const path = '/fixture/中文样例.' + extension
      root.render(React.createElement(SheetPreview, {key:extension, path,reloadKey:0,
        target:{kind:'file',path,label:'中文样例.'+extension,source:path,url:'file://'+path,previewKind:'binary'},
        onFailure: failure => window.failures.push(failure)
      }))
    }
  `)
  const output = path.join(root, 'renderer')
  await build({ root: desktop, logLevel: 'warn', build: { outDir: output, emptyOutDir: true, manifest: 'manifest.json', reportCompressedSize: false, rolldownOptions: { input: entry } } })
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'))
  const built = Object.values(manifest).find(item => item.isEntry)
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>独立表格检查</title>
    ${(built.css || []).map(file => `<link rel="stylesheet" href="./${file}">`).join('')}
    <style>html,body,#root{width:100%;height:100%;margin:0}</style>
    <div id="root"></div><script type="module" src="./${built.file}"></script>`)
  await bundle({ stdin: { contents: `
    import { app, BrowserWindow } from 'electron'
    app.disableHardwareAcceleration()
    app.setPath('userData',${JSON.stringify(path.join(root, 'user-data'))})
    app.whenReady().then(()=>{
      const window=new BrowserWindow({show:false,width:1000,height:720,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
      window.loadURL('about:blank')
    })
    app.on('window-all-closed',()=>app.quit())
  `, resolveDir: desktop }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(root, 'main.cjs') })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  const messages = []
  const external = []
  const blockedBaselineFonts = []
  let styleEvidence
  let imageEvidence
  try {
    app = await electron.launch({ executablePath: electronPath, args: [path.join(root, 'main.cjs')], cwd: desktop, env })
    const page = await app.firstWindow()
    page.on('pageerror', error => messages.push(String(error)))
    await page.route('**/*', route => {
      if (/^(file:|data:|blob:)/.test(route.request().url())) { return route.continue() }
      // 全局 styles.css 已有的字体，与新增表格无关；仍阻断，不掩盖其它外部请求。
      if (route.request().url() === 'https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&display=swap') {
        blockedBaselineFonts.push(route.request().url())

        return route.abort()
      }
      external.push(route.request().url())

      return route.abort()
    })
    await page.goto(pathToFileURL(path.join(output, 'index.html')).href)
    await page.waitForFunction(() => typeof window.loadSheet === 'function')
    for (const extension of Object.keys(files)) {
      await page.evaluate(extension => window.loadSheet(extension), extension)
      await page.waitForFunction(() => window.painted.join('').includes('中文数据'))
      if (extension === 'xlsx') {
        styleEvidence = await page.evaluate(() => ({
          text: window.stylePaints.filter(item => item.color === '#990000'),
          multiline: window.stylePaints.filter(item => item.text.includes('中文换行') || item.text === '第二行'),
          backgrounds: [...window.backgrounds], strokes: [...window.strokes]
        }))
        assert.ok(styleEvidence.text.some(item => /bold/.test(item.font) && /italic/.test(item.font) && /Arial/.test(item.font)), JSON.stringify(styleEvidence))
        assert.ok(styleEvidence.text.every(item => !item.font.includes('Arial, Calibri')), JSON.stringify(styleEvidence))
        assert.ok(new Set(styleEvidence.multiline.map(item => item.y)).size >= 2, JSON.stringify(styleEvidence))
        assert.ok(styleEvidence.backgrounds.includes('#ffeedd'), JSON.stringify(styleEvidence))
        assert.ok(styleEvidence.strokes.includes('#008800'), JSON.stringify(styleEvidence))
        const png = await page.locator('canvas').evaluateAll(items => items.toSorted((a,b) => b.width*b.height-a.width*a.height)[0].toDataURL('image/png'))
        await fs.writeFile(path.join(root, 'styled-canvas.png'), Buffer.from(png.split(',')[1], 'base64'))
        const images = page.locator('#luckysheet-image-showBoxs .img-list img')
        await expect(images).toHaveCount(3)
        imageEvidence = await images.evaluateAll(async items => {
          const results = []
          for (const image of items) {
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = image.width
            canvas.height = image.height
            const ctx = canvas.getContext('2d')
            ctx.drawImage(image,0,0,image.width,image.height)
            results.push({ width:image.width,height:image.height,
              pixel:[...ctx.getImageData(Math.floor(image.width/4),Math.floor(image.height/2),1,1).data],
              left:image.parentElement.parentElement.style.left,top:image.parentElement.parentElement.style.top,
              png:canvas.toDataURL('image/png') })
          }

          return results
        })
        assert.deepEqual(imageEvidence[0].pixel,[0,0,255,255])
        assert.deepEqual(imageEvidence[1].pixel,[255,0,0,255])
        assert.deepEqual(imageEvidence[2].pixel,[0,0,255,255])
        assert.equal(imageEvidence[0].width,96)
        assert.equal(imageEvidence[0].height,64)
        await images.first().click()
        assert.equal(await page.locator('#luckysheet-modal-dialog-activeImage').count(),0,'只读预览不能进入图片编辑状态')
        for (const [index, item] of imageEvidence.entries()) {
          await fs.writeFile(path.join(root,`picture-${index+1}.png`),Buffer.from(item.png.split(',')[1],'base64'))
          delete item.png
        }
      }
      await expect(page.getByText('Some sheets exceed 500 rows. Only their first 500 rows are shown.')).toBeVisible()
      assert.ok(await page.locator('canvas').evaluateAll(items => items.some(item => item.width > 0 && item.height > 0)))
      await page.getByText('汇总', { exact: true }).click()
      await page.waitForFunction(() => window.painted.join('').includes('第二表内容'))
      const position = await page.locator('canvas').evaluateAll(items => {
        const canvas = items.toSorted((a,b) => b.width*b.height-a.width*a.height)[0]
        const bounds = canvas.getBoundingClientRect()

        return { x:bounds.x+100, y:bounds.y+38 }
      })
      await page.evaluate(() => { window.painted = [] })
      await page.mouse.dblclick(position.x,position.y)
      await page.keyboard.press('F2')
      await page.keyboard.insertText('PREVIEW_SHOULD_NOT_EDIT')
      await page.keyboard.press('Enter')
      const before = await page.locator('canvas').evaluateAll(items => items.map(item => item.width).join(','))
      await page.evaluate(() => { document.getElementById('root').style.width = '650px' })
      await expect.poll(() => page.locator('canvas').evaluateAll(items => items.map(item => item.width).join(','))).not.toBe(before)
      await page.waitForFunction(() => window.painted.join('').includes('第二表内容'))
      assert.ok(!await page.evaluate(() => window.painted.join('').includes('PREVIEW_SHOULD_NOT_EDIT')))
    }
    assert.deepEqual(await page.evaluate(() => window.failures), [])
    assert.equal(await page.evaluate(() => window.reads.length), 3)
    assert.deepEqual(messages, [])
    assert.deepEqual(external, [])
    console.log('三种格式、XLSX 样式与三种锚点图片通过实际显示；裁剪、翻转、只读、切表和尺寸检查通过。复杂文件仍待用户验收。')
  } finally {
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ messages, external, blockedBaselineFonts, styleEvidence,imageEvidence }, null, 2))
    await app?.close()
  }
})
