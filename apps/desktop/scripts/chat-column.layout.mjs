import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chromium } from '@playwright/test'
import { build, preview } from 'vite'

/** 使用正式聊天和输入组件检查列宽、边界及响应式变化，不启动用户应用或后端。 */
test('聊天阅读列与输入框在宽窗、预览及窄窗下保持居中对齐', { timeout: 180_000 }, async () => {
  const desktop = path.resolve(import.meta.dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uniworker-chat-column-'))
  const entry = path.join(root, 'fixture.jsx')
  const resolve = createRequire(import.meta.url).resolve
  /** 临时入口直接引用正式组件和样式，不复制产品布局规则。 */
  const source = name => JSON.stringify(path.join(desktop, name))
  console.log('聊天布局验收记录：' + root)
  await fs.writeFile(
    entry,
    `
    import React,{useState} from ${JSON.stringify(resolve('react'))}
    import {createRoot} from ${JSON.stringify(resolve('react-dom/client'))}
    import {MemoryRouter} from ${JSON.stringify(resolve('react-router'))}
    import {AssistantRuntimeProvider,useExternalStoreRuntime} from ${JSON.stringify(resolve('@assistant-ui/react'))}
    // 与正式组件使用同一 ESM 入口，避免 CJS 另建一份查询上下文。
    import {QueryClient,QueryClientProvider} from ${JSON.stringify(resolve('@tanstack/react-query').replace(/\.cjs$/, '.js'))}
    import {I18nProvider} from ${source('src/i18n/context.tsx')}
    import {ThemeProvider,useTheme} from ${source('src/themes/context.tsx')}
    import {RootTooltipProvider} from ${source('src/components/ui/tooltip.tsx')}
    import {Thread} from ${source('src/components/assistant-ui/thread/index.tsx')}
    import {ChatBar,ChatBarFallback} from ${source('src/app/chat/composer/index.tsx')}
    import {toChatMessages} from ${source('src/lib/chat-messages/index.ts')}
    import {toRuntimeMessage} from ${source('src/lib/chat-runtime.ts')}
    import ${source('src/styles.css')}
    const text = ${JSON.stringify(
      '已整理本周交付内容，报告、表格与源代码位于当前工作区。\n\n' +
        '### 交付清单\n\n| 文件 | 内容 | 状态 |\n| --- | --- | --- |\n| 项目周报.docx | 本周进展、结论与后续安排 | 已完成 |\n| 数据汇总.xlsx | 三个工作表及对比图表 | 已完成 |\n\n' +
        '正文、表格、文件卡片和下方输入框共用居中的阅读区域。打开侧栏或文件预览后，阅读区域跟随剩余窗格调整。\n\n' +
        '```js\nconst result = "' +
        'long_example_'.repeat(24) +
        '"\nconsole.log(result)\n```\n\n' +
        'MEDIA: ' +
        path.join(root, '项目周报.docx')
    )}
    const stored=toChatMessages([
      {role:'user',content:'帮我整理本周进展，输出一份报告和汇总表，并列出后续安排。'},
      {role:'assistant',content:text}
    ])
    const state={model:{canSwitch:false,model:'GLM 5.2',provider:'custom'},tools:{enabled:false,label:''},voice:{enabled:false,active:false}}
    const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}})
    // 布局开关仅控制测试侧栏占位和场景；正式消息、输入与滚动组件保持原实现。
    function Fixture(){
      const [layout,setLayout]=useState({left:260,right:0,welcome:false,fallback:false})
      const theme=useTheme()
      window.setFixtureLayout=next=>{theme.setMode(next.dark?'dark':'light');setLayout(next)}
      const runtime=useExternalStoreRuntime({messages:layout.welcome?[]:stored.map(toRuntimeMessage),isRunning:false,onNew:async()=>{}})
      return <MemoryRouter><I18nProvider configClient={null} initialLocale="zh"><AssistantRuntimeProvider runtime={runtime}>
        <div className="font-sans text-foreground" style={{display:'flex',height:'100vh',overflow:'hidden'}}>
          {layout.left>0&&<aside data-testid="sidebar" style={{width:layout.left,flexShrink:0,padding:20,background:'var(--ui-bg-sidebar)'}}>
            <strong>元景数字员工</strong><p>新对话</p><p>专家 · 技能 · 连接器</p><p>消息平台</p><p>资料库</p><p>定时任务</p><hr/><p>本周工作总结</p><p>项目资料整理</p>
          </aside>}
          <main data-chat-surface="" data-welcome-layout={layout.welcome?'centered':undefined} style={{position:'relative',flex:1,minWidth:0,display:'flex',flexDirection:'column',background:'var(--ui-chat-surface-background)'}}>
            <header style={{height:52,flexShrink:0,padding:'16px 24px'}}>本周工作总结</header>
            <div style={{flex:1,minHeight:0,position:'relative'}}><Thread clampToComposer intro={layout.welcome?{}:undefined}/></div>
            {layout.fallback?<ChatBarFallback showWelcomeTemplates={layout.welcome}/>:<ChatBar busy={false} disabled={false} gateway={null} onCancel={()=>{}} onSubmit={async()=>true} showWelcomeTemplates={layout.welcome} state={state}/>}
          </main>
          {layout.right>0&&<aside data-testid="preview" style={{width:layout.right,flexShrink:0,padding:24,borderLeft:'1px solid var(--dt-border)'}}><strong>项目周报.docx</strong><p>文件预览区域（布局占位）</p></aside>}
        </div>
      </AssistantRuntimeProvider></I18nProvider></MemoryRouter>
    }
    createRoot(document.getElementById('root')).render(<QueryClientProvider client={queryClient}><ThemeProvider><RootTooltipProvider><Fixture/></RootTooltipProvider></ThemeProvider></QueryClientProvider>)
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
      minify: false,
      rolldownOptions: { input: entry }
    }
  })
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'))
  const built = Object.values(manifest).find(item => item.isEntry)
  await fs.writeFile(
    path.join(output, 'index.html'),
    '<!doctype html><html data-hermes-theme="uniwork"><meta charset="utf-8">' +
      (built.css || []).map(name => `<link rel="stylesheet" href="./${name}">`).join('') +
      `<body style="margin:0"><div id="root"></div><script type="module" src="./${built.file}"></script></body></html>`
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
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => {
      errors.push(error.message)
      console.error(error.message)
    })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'load' })
    await page.locator('[data-slot="composer-surface"]').waitFor()
    const toolbar = page.locator('[data-slot="aui_msg-actions"]').last()
    await toolbar.waitFor()
    const actions = await toolbar.evaluate(node => ({
      gap: getComputedStyle(node).columnGap,
      buttons: [...node.querySelectorAll('button')].map(button => {
        const rect = button.getBoundingClientRect()
        const icon = button.querySelector('svg').getBoundingClientRect()
        return { width: rect.width, height: rect.height, iconWidth: icon.width, iconHeight: icon.height }
      })
    }))
    assert.ok(actions.buttons.length >= 2, '正式回复工具条须提供复制与重新生成操作')
    assert.equal(actions.gap, '4px', '回复按钮间距应与 UniWork 一致')
    for (const button of actions.buttons) {
      assert.deepEqual(button, { width: 24, height: 24, iconWidth: 14, iconHeight: 14 })
    }
    const firstAction = toolbar.locator('button').first()
    const initialBackground = await firstAction.evaluate(button => getComputedStyle(button).backgroundColor)
    await firstAction.hover()
    await page.waitForFunction(
      previous =>
        getComputedStyle(document.querySelector('[data-slot="aui_msg-actions"] button')).backgroundColor !== previous,
      initialBackground,
      { timeout: 3000 }
    )
    await page.mouse.move(0, 0)
    const receipt = []
    for (const scenario of [
      { name: 'wide', width: 1920, height: 1080, left: 260, right: 0 },
      { name: 'fullscreen', width: 1920, height: 1080, left: 0, right: 0 },
      { name: 'preview', width: 1600, height: 1000, left: 260, right: 420 },
      { name: 'narrow', width: 640, height: 900, left: 0, right: 0 },
      { name: 'dark', width: 1600, height: 1000, left: 260, right: 0, dark: true },
      { name: 'welcome', width: 1600, height: 1000, left: 260, right: 0, welcome: true },
      { name: 'welcome-fallback', width: 1600, height: 1000, left: 260, right: 0, welcome: true, fallback: true },
      { name: 'fallback', width: 1600, height: 1000, left: 260, right: 0, fallback: true }
    ]) {
      await page.setViewportSize({ width: scenario.width, height: scenario.height })
      await page.evaluate(layout => {
        document.documentElement.classList.toggle('dark', Boolean(layout.dark))
        window.setFixtureLayout(layout)
      }, scenario)
      await page.locator(scenario.fallback ? '.composer-fallback-surface' : '[data-slot="composer-surface"]').waitFor()
      assert.equal(
        await page.locator('[data-slot="composer-disclaimer"]').isVisible(),
        !scenario.welcome,
        '提示只在对话开始后显示，欢迎页及其加载占位应隐藏'
      )
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const geometry = await page.evaluate(() => {
        const chat = document.querySelector('[data-chat-surface]').getBoundingClientRect()
        const thread = document.querySelector('[data-slot="aui_thread-content"]')
        const bounds = thread.getBoundingClientRect()
        const style = getComputedStyle(thread)
        const left = bounds.left + parseFloat(style.paddingLeft)
        const right = bounds.right - parseFloat(style.paddingRight)
        const input = document
          .querySelector('[data-slot="composer-surface"],.composer-fallback-surface')
          .getBoundingClientRect()
        return {
          chat: { left: chat.left, right: chat.right },
          text: { left, right, width: right - left },
          input: { left: input.left, right: input.right, width: input.width },
          overflow: document.documentElement.scrollWidth > innerWidth
        }
      })
      await page.screenshot({ path: path.join(root, scenario.name + '.png') })
      receipt.push({ scenario: scenario.name, ...geometry })
      assert.ok(geometry.input.width <= 881, '输入框可见宽度不能超出阅读列上限')
      assert.ok(
        Math.abs(geometry.input.left + geometry.input.right - geometry.chat.left - geometry.chat.right) < 2,
        '输入框须以当前聊天窗格居中'
      )
      if (!scenario.welcome) {
        assert.ok(Math.abs(geometry.text.left - geometry.input.left) <= 4, '正文与输入框左边界应对齐')
        assert.ok(Math.abs(geometry.text.right - geometry.input.right) <= 4, '正文与输入框右边界应对齐')
      }
      assert.equal(geometry.overflow, false, '页面不能横向溢出')
    }
    assert.deepEqual(errors, [])
    await fs.writeFile(path.join(root, 'receipt.json'), JSON.stringify({ receipt, errors }, null, 2))
  } finally {
    await browser?.close()
    await new Promise((resolve, reject) => server.httpServer.close(error => (error ? reject(error) : resolve())))
  }
})
