/* global document */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { _electron as electron } from '@playwright/test'
import electronPath from 'electron'
import { createServer } from 'vite'

const desktop = path.resolve(import.meta.dirname, '..')
const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-mcp-ui-'))
const errors = []
const moduleId = '\0mcp-renderer-fixture'
const controllerId = '\0mcp-renderer-controller'
const rpcId = '\0mcp-renderer-rpc'

/** 重绘后取得非空图像，避免隐藏窗口刚调整尺寸时产生零字节截图。 */
async function capturePng(instance, page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))))
  await instance.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.invalidate())
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const png = await instance.evaluate(async ({BrowserWindow}) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true})
      return image.isEmpty() ? null : image.toPNG().toString('base64')
    })
    if (png) return Buffer.from(png,'base64')
    await new Promise(resolve => setTimeout(resolve,100))
  }
  throw new Error('隐藏 Electron 窗口未生成有效截图')
}

/** 数据受控，页面、原生工具视图、编辑器和样式实际在隐藏 Electron 窗口加载。 */
function fixturePlugin() {
  return {
    name: 'mcp-renderer-fixture', enforce: 'pre',
    /** 只替换本夹具的配置和网络来源，不改变产品文件。 */
    resolveId(source) {
      if (source === '/mcp-fixture-entry.tsx') return moduleId
      if (source.endsWith('/use-mcp-servers')) return controllerId
      if (source.endsWith('/data/rpc')) return rpcId
    },
    /** 输出受控模块；不会请求 MaaS、模型或真实 MCP 服务。 */
    load(id) {
      if (id === rpcId) return `
        export const listMcpServers=async()=>({servers:[]});
        export const mcpServerStatus=async()=>({servers:[]});
        export const setMcpBearerToken=async()=>({ok:true});
      `
      if (id === controllerId) return `
        // 仅返回本轮受控配置，真实后端行为另由 M01 验证。
        export function useMcpServers() {
          return {servers:{'UniAI-Toolkit':{url:'https://example.invalid/mcp?key=sk-••••••TAIL',timeout:600},
              'test-reader':{command:'node',args:['reader.js','--root','C:/docs']},
              'test-http':{url:'https://example.invalid/mcp',headers:{'X-Team':'docs'},enabled:false}},
            statuses:{'UniAI-Toolkit':'ok','test-reader':'ok','test-http':'off'},
            probes:{'UniAI-Toolkit':{ok:true,tools:[{name:'text_to_image',description:''},{name:'asr',description:''}]},
              'test-reader':{ok:true,tools:[{name:'read_document',description:'Read a test document'}]}},
            toolCounts:{},profilePending:false,configLoading:false,configFailed:false,saving:false,authing:null,
            runProbe:async()=>null,replaceServers:async()=>true,removeServer:async()=>true,
            authenticate:async()=>{},refetchConfig:()=>{}};
        }
      `
      if (id === moduleId) return `
        import React,{useEffect} from 'react';
        import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {MemoryRouter} from 'react-router';
        import {I18nProvider} from '/src/i18n/context';
        import {ThemeProvider,useTheme} from '/src/themes/context';
        import {ConnectorsPage} from '/src/app/capabilities/mcp-mt/connectors-page';
        import '/src/styles.css';
        window.hermesDesktop={...window.hermesDesktop,
          getConnectionConfig:async()=>({mode:'local'}),
          localConnectors:async(input)=>({connectors:[{id:'qq_mail',connected:input.operation==='connect'}]})};
        // 使用产品原生主题切换，避免只改部分颜色导致错误的明暗截图。
        function FixtureTheme() {
          const {setMode}=useTheme();
          useEffect(()=>{window.fixtureSetMode=setMode},[setMode]);
          return React.createElement(MemoryRouter,null,
            React.createElement(ConnectorsPage,{gateway:null,profile:'work',scopeLabel:'work'}));
        }
        createRoot(document.getElementById('root')).render(React.createElement(ThemeProvider,null,
          React.createElement(I18nProvider,
          {configClient:null,initialLocale:'zh'},React.createElement(QueryClientProvider,
          {client:new QueryClient()},React.createElement(FixtureTheme)))));
      `
    },
    /** 提供独立测试入口，不占用产品路由和用户开发端口。 */
    configureServer(server) {
      server.middlewares.use('/mcp-fixture.html', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(await server.transformIndexHtml('/mcp-fixture.html', `<!doctype html><html><head>
          <meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}
          body{background:var(--dt-background);color:var(--ui-text-primary)}</style></head>
          <body><div id="root"></div><script type="module" src="/mcp-fixture-entry.tsx"></script></body></html>`))
      })
    }
  }
}

const server = await createServer({ root: desktop, cacheDir: path.join(root, 'cache'), logLevel: 'warn',
  server: {host:'127.0.0.1',port:0,strictPort:false,open:false}, plugins:[fixturePlugin()] })
let instance
try {
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}/mcp-fixture.html`
  const main = path.join(root, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(root,'user-data'))});app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('force-device-scale-factor','1');
    app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1000,height:760,
      webPreferences:{nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});w.loadURL(${JSON.stringify(url)});});`)
  const env = {...process.env}
  delete env.ELECTRON_RUN_AS_NODE
  instance = await electron.launch({executablePath:electronPath,args:[main],env,timeout:45000})
  const page = await instance.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('tab',{name:'推荐'}).waitFor({timeout:60000})
  for (const dark of [false,true]) {
    for (const width of [1400,1000,460]) {
      await instance.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(size,760),width)
      await page.evaluate(value => window.fixtureSetMode(value ? 'dark' : 'light'),dark)
      await page.waitForFunction(value => document.documentElement.dataset.hermesMode === value,dark?'dark':'light')
      await page.waitForFunction(value => window.innerWidth === value,width)
      const png = await capturePng(instance,page)
      assert.ok(png.length > 100,'每张截图都必须有实际内容')
      await writeFile(path.join(root,`${dark?'dark':'light'}-${width}.png`),png)
      const fits = await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)
      assert.ok(fits,`页面不得横向溢出：${width}`)
      assert.equal(await page.locator('.mt-connector-icon').evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0)),true,'推荐图标必须全部正常加载')
    }
  }
  await page.getByRole('button',{name:'查看QQ 邮箱',exact:true}).click()
  await page.getByRole('dialog').getByText('试试这样用').waitFor()
  await writeFile(path.join(root,'detail-dark-460.png'),await capturePng(instance,page))
  await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1400,960))
  await page.evaluate(()=>window.fixtureSetMode('light'))
  await page.waitForFunction(()=>document.documentElement.dataset.hermesMode === 'light')
  await page.waitForFunction(()=>window.innerWidth === 1400 && document.querySelector('[role="dialog"]').getBoundingClientRect().width >= 770)
  console.log('Dialog layout', await page.getByRole('dialog').evaluate(el => ({width:el.getBoundingClientRect().width, background:getComputedStyle(el).backgroundColor})))
  await writeFile(path.join(root,'detail-light-1400.png'),await capturePng(instance,page))
  await page.getByRole('dialog').getByRole('button',{name:'连接',exact:true}).click()
  await page.getByLabel('邮箱地址').fill('fixture@qq.com')
  await page.getByLabel('授权码').fill('fixture-only-not-a-real-key')
  await writeFile(path.join(root,'credentials-light-1400.png'),await capturePng(instance,page))
  await page.getByRole('dialog').getByRole('button',{name:'连接',exact:true}).click()
  await page.getByRole('dialog').getByText('已就绪，可在新聊天中使用；现有会话保持原工具集。').waitFor()
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()
  await page.getByRole('tab',{name:'MCP',exact:true}).click()
  await page.getByRole('heading',{name:'自定义 MCP'}).waitFor()
  await page.getByRole('button',{name:'test-reader',exact:true}).click()
  await writeFile(path.join(root,'mcp-dark-460.png'),await capturePng(instance,page))
  await page.getByRole('button',{name:'添加 MCP 服务器',exact:true}).click()
  await page.getByRole('button',{name:'HTTP',exact:true}).click()
  const addServer = page.getByRole('article',{name:'未命名服务器'})
  await addServer.getByLabel('名称').waitFor()
  assert.equal(await addServer.getByLabel('名称').evaluate(input=>document.activeElement===input),true,'新增服务必须聚焦名称输入框')
  assert.equal(await addServer.getByLabel('地址').isVisible(),true,'选择 HTTP 后必须显示完整配置表单')
  await writeFile(path.join(root,'add-mcp-http-form.png'),await capturePng(instance,page))
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),'MCP 页面不得横向溢出')
  assert.deepEqual(errors,[])
  console.log(`连接器受控 Renderer：6 个主题／尺寸组合、详情和原生 MCP 入口通过；截图 ${root}`)
} finally {
  await instance?.close()
  await server.close()
}
