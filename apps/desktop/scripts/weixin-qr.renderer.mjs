/* global document, requestAnimationFrame, window */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { _electron as electron } from '@playwright/test'
import electronPath from 'electron'
import { createServer } from 'vite'

const desktop = path.resolve(import.meta.dirname, '..')
const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-weixin-ui-'))
const errors = []
const moduleId = '\0weixin-renderer-fixture'
const apiId = '\0weixin-renderer-api'

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

/** 组件、主题和样式真实加载；只把扫码接口换成受控结果，不连接微信或后端。 */
function fixturePlugin() {
  return {
    name: 'weixin-renderer-fixture',
    enforce: 'pre',
    /** 替换扫码接口模块并提供夹具入口。 */
    resolveId(source) {
      if (source === '/weixin-fixture-entry.tsx') return moduleId
      if (source === '@/api/weixin-qr' || source.replace(/\\/g, '/').endsWith('/api/weixin-qr')) return apiId
    },
    /** 受控接口按 window.fixtureState 回答状态；入口按产品同样的卡片布局渲染组件。 */
    load(id) {
      if (id === apiId) {
        return `
        const login = state => ({message:'',qr_content:'https://liteapp.weixin.qq.com/q/demo',session_id:'wx-1',state});
        export const startWeixinQrLogin = async () => login('wait');
        export const getWeixinQrLogin = async () => login(window.fixtureState || 'wait');
        export const unbindWeixin = async () => ({ok:true,restart_started:true});
      `
      }
      if (id !== moduleId) return
      return `
        import React,{useEffect,useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {I18nProvider} from '/src/i18n/context';
        import {ThemeProvider,useTheme} from '/src/themes/context';
        import {WeixinQrSetup} from '/src/app/messaging/weixin-qr-setup';
        import '/src/styles.css';
        const base={description:'',docs_url:'',enabled:false,env_vars:[],gateway_running:true,id:'weixin',name:'微信',state:'not_configured'};
        function Card(){
          const {setMode}=useTheme();
          const [configured,setConfigured]=useState(false);
          useEffect(()=>{window.fixtureSetMode=setMode;window.fixtureConfigured=setConfigured},[setMode]);
          return React.createElement('div',{className:'p-6'},React.createElement(WeixinQrSetup,{
            onSaved:()=>setConfigured(true),onUnbound:()=>setConfigured(false),
            platform:{...base,configured,state:configured?'connected':'not_configured'},scopeProfile:undefined}));
        }
        createRoot(document.getElementById('root')).render(React.createElement(ThemeProvider,null,
          React.createElement(I18nProvider,{configClient:null,initialLocale:'zh'},React.createElement(Card))));
      `
    },
    /** 提供独立测试入口，不占用产品路由和用户开发端口。 */
    configureServer(server) {
      server.middlewares.use('/weixin-fixture.html', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(
          await server.transformIndexHtml(
            '/weixin-fixture.html',
            `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}
          body{background:var(--dt-background);color:var(--ui-text-primary)}</style></head>
          <body><div id="root"></div><script type="module" src="/weixin-fixture-entry.tsx"></script></body></html>`
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
  const url = `http://127.0.0.1:${server.httpServer.address().port}/weixin-fixture.html`
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
  const connect = page.getByRole('button', { name: /扫码连接/ })
  await connect.waitFor({ timeout: 60000 })

  /** 依次截取未连接、等待扫码、已扫码、过期和已连接五种状态。 */
  async function shoot(name) {
    await writeFile(path.join(root, `${name}.png`), await capturePng(instance, page))
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
    assert.ok(fits, `页面不得横向溢出：${name}`)
  }

  for (const dark of [false, true]) {
    for (const width of [900, 460]) {
      await instance.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size, 640), width)
      await page.evaluate(value => window.fixtureSetMode(value ? 'dark' : 'light'), dark)
      await page.waitForFunction(value => document.documentElement.dataset.hermesMode === value, dark ? 'dark' : 'light')
      await page.waitForFunction(value => window.innerWidth === value, width)
      await page.evaluate(() => {
        window.fixtureState = 'wait'
      })
      await connect.click()
      await page.getByAltText('扫码连接').waitFor()
      await shoot(`${dark ? 'dark' : 'light'}-${width}-wait`)
      await page.evaluate(() => {
        window.fixtureState = 'scanned'
      })
      await page.getByText('已扫码，请在手机上确认').waitFor()
      await shoot(`${dark ? 'dark' : 'light'}-${width}-scanned`)
      await page.getByRole('button', { name: '取消' }).click()
    }
  }

  await page.evaluate(() => {
    window.fixtureState = 'expired'
  })
  await connect.click()
  await page.getByRole('button', { name: /刷新二维码/ }).waitFor()
  await shoot('dark-460-expired')
  await page.getByRole('button', { name: '取消' }).click()
  await page.evaluate(() => window.fixtureConfigured(true))
  await page.getByRole('button', { name: /重新扫码/ }).waitFor()
  await shoot('dark-460-connected')

  assert.deepEqual(errors, [])
  console.log(`微信扫码受控 Renderer：4 个主题／尺寸组合与过期、已连接状态通过；截图 ${root}`)
} finally {
  await instance?.close()
  await server.close()
}
