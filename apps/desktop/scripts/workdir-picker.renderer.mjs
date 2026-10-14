/* global document, requestAnimationFrame, window */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { _electron as electron } from '@playwright/test'
import electronPath from 'electron'
import { createServer } from 'vite'

const desktop = path.resolve(import.meta.dirname, '..')
const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-workdir-ui-'))
const errors = []
const moduleId = '\0workdir-renderer-fixture'

/** 重绘后取得非空图像，避免隐藏窗口刚调整尺寸时产生零字节截图。 */
async function capturePng(instance, page) {
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.invalidate())
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const png = await instance.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true })
      return image.isEmpty() ? null : image.toPNG().toString('base64')
    })
    if (png) return Buffer.from(png, 'base64')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('隐藏 Electron 窗口未生成有效截图')
}

/** 选择器组件、主题和样式真实加载；后端只回答默认工作区，不连接 MaaS 或模型。 */
function fixturePlugin() {
  return {
    name: 'workdir-renderer-fixture',
    enforce: 'pre',
    /** 只提供本夹具入口，不替换产品模块。 */
    resolveId(source) {
      if (source === '/workdir-fixture-entry.tsx') return moduleId
    },
    /** 按输入框同样的网格排出“+”、目录按钮、输入区和发送区。 */
    load(id) {
      if (id !== moduleId) return
      return `
        import React,{useEffect,useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {I18nProvider} from '/src/i18n/context';
        import {ThemeProvider,useTheme} from '/src/themes/context';
        import {WorkdirPicker} from '/src/app/chat/composer/workdir-mt/workdir-picker';
        import {$sessions,setNewChatWorkspaceTarget} from '/src/store/session';
        import '/src/styles.css';
        const gateway={request:async(method,params={})=>({branch:'',cwd:params.cwd??'C:\\\\Users\\\\stan\\\\AppData\\\\Local\\\\hermes-desktop-mt\\\\accounts\\\\demo\\\\workspace'})};
        $sessions.set([{cwd:'D:\\\\work\\\\quarterly-report',last_active:9},{cwd:'D:\\\\work\\\\contracts-2026',last_active:5}]);
        setNewChatWorkspaceTarget(null);
        function Row(){
          const {setMode}=useTheme();
          const [sessionId,setSessionId]=useState(null);
          useEffect(()=>{window.fixtureSetMode=setMode;window.fixtureStart=()=>setSessionId('runtime-1')},[setMode]);
          return React.createElement('div',{className:'p-6 pt-80'},
            React.createElement('div',{className:'rounded-2xl border border-border bg-(--composer-fill) px-3 py-2'},
              React.createElement('div',{className:'grid w-full grid-cols-[auto_1fr_auto] items-center gap-(--composer-control-gap) [grid-template-areas:"menu_input_controls"]'},
                React.createElement('div',{className:'flex items-start gap-(--composer-control-gap) [grid-area:menu]'},
                  React.createElement('button',{className:'size-(--composer-control-size) rounded-md text-(--ui-text-tertiary)'},'+'),
                  React.createElement(WorkdirPicker,{cwd:sessionId?'D:\\\\work\\\\quarterly-report':'',gateway,sessionId})),
                React.createElement('div',{className:'min-w-0 text-sm text-(--ui-text-tertiary) [grid-area:input]'},'输入消息…'),
                React.createElement('div',{className:'[grid-area:controls] text-xs text-(--ui-text-tertiary)'},'模型 ▾  ●'))));
        }
        createRoot(document.getElementById('root')).render(React.createElement(ThemeProvider,null,
          React.createElement(I18nProvider,{configClient:null,initialLocale:'zh'},React.createElement(Row))));
      `
    },
    /** 提供独立测试入口，不占用产品路由和用户开发端口。 */
    configureServer(server) {
      server.middlewares.use('/workdir-fixture.html', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(
          await server.transformIndexHtml(
            '/workdir-fixture.html',
            `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}
          body{background:var(--dt-background);color:var(--ui-text-primary)}</style></head>
          <body><div id="root"></div><script type="module" src="/workdir-fixture-entry.tsx"></script></body></html>`
          )
        )
      })
    }
  }
}

const server = await createServer({
  root: desktop,
  cacheDir: path.join(root, 'cache'),
  logLevel: 'warn',
  server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
  plugins: [fixturePlugin()]
})
let instance
try {
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}/workdir-fixture.html`
  const main = path.join(root, 'main.cjs')
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(root, 'user-data'))});app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('force-device-scale-factor','1');
    app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:900,height:640,
      webPreferences:{nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});w.loadURL(${JSON.stringify(url)});});`
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  instance = await electron.launch({ executablePath: electronPath, args: [main], env, timeout: 45000 })
  const page = await instance.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  const trigger = page.getByTestId('workdir-picker')
  await trigger.waitFor({ timeout: 60000 })

  for (const dark of [false, true]) {
    for (const width of [900, 460]) {
      await instance.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size, 640), width)
      await page.evaluate(value => window.fixtureSetMode(value ? 'dark' : 'light'), dark)
      await page.waitForFunction(value => document.documentElement.dataset.hermesMode === value, dark ? 'dark' : 'light')
      await page.waitForFunction(value => window.innerWidth === value, width)
      const name = `${dark ? 'dark' : 'light'}-${width}`
      await writeFile(path.join(root, `${name}-closed.png`), await capturePng(instance, page))
      await trigger.click()
      await page.getByRole('menuitem', { name: /选择其他文件夹/ }).waitFor()
      await writeFile(path.join(root, `${name}-menu.png`), await capturePng(instance, page))
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
      assert.ok(fits, `页面不得横向溢出：${width}`)
      await page.keyboard.press('Escape')
    }
  }

  // 对话开始后：按钮只显示目录名，点开是只读说明。
  await page.evaluate(() => window.fixtureStart())
  await page.getByText('quarterly-report', { exact: true }).waitFor()
  await trigger.click()
  await page.getByText(/本次对话已绑定该目录/).waitFor()
  await writeFile(path.join(root, 'dark-460-locked.png'), await capturePng(instance, page))
  assert.equal(await page.getByRole('menuitem').count(), 0)

  assert.deepEqual(errors, [])
  console.log(`工作目录选择器受控 Renderer：4 个主题／尺寸组合与锁定状态通过；截图 ${root}`)
} finally {
  await instance?.close()
  await server.close()
}
