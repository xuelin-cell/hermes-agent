import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from '@playwright/test'
import { build, preview } from 'vite'

const desktop = path.resolve(import.meta.dirname, '..')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uniwork-settings-'))
const resolve = createRequire(import.meta.url).resolve
const source = name => JSON.stringify(path.join(desktop, name))
const entry = path.join(root, 'fixture.jsx')
await fs.writeFile(entry, `
import React from ${JSON.stringify(resolve('react'))}
import {createRoot} from ${JSON.stringify(resolve('react-dom/client'))}
import {MemoryRouter} from ${JSON.stringify(resolve('react-router'))}
import {QueryClient,QueryClientProvider} from ${JSON.stringify(resolve('@tanstack/react-query').replace(/\.cjs$/, '.js'))}
import {I18nProvider} from ${source('src/i18n/context.tsx')}
import {ThemeProvider,useTheme} from ${source('src/themes/context.tsx')}
import {RootTooltipProvider} from ${source('src/components/ui/tooltip.tsx')}
import {GeneralSettings} from ${source('src/app/settings/general-settings.tsx')}
import {GroupedSettingsNavigation} from ${source('src/app/settings/grouped-navigation.tsx')}
import {OverlayMain,OverlaySplitLayout} from ${source('src/app/overlays/overlay-split-layout.tsx')}
import {Info} from ${source('src/lib/icons.ts')}
import ${source('src/styles.css')}
import ${source('src/app/settings/settings-redesign.css')}
window.hermesDesktop={api:async()=>({language:'zh',mcp_servers:{'UniWork-Drive':{uniwork_managed:'uniwork.desktop.drive.v1'}}}),settings:{getDefaultProjectDir:async()=>({dir:'D:/工作空间',defaultLabel:'默认工作空间'})}}
function Fixture(){const theme=useTheme();window.setFixtureMode=theme.setMode;return <I18nProvider><MemoryRouter><div className="settings-redesign" style={{height:'100vh','--titlebar-height':'34px'}}><OverlaySplitLayout className="settings-redesign-layout"><GroupedSettingsNavigation groups={[
['general','通用'],['models','模型'],['messaging','连接手机'],['sessions','数据管理'],['config:safety','安全中心'],['about','关于'],['help','获取帮助']].map(([id,label])=>({id,label,icon:Info,active:id==='general',onSelect:()=>{}}))}/><OverlayMain className="px-0 pb-0"><GeneralSettings/></OverlayMain></OverlaySplitLayout></div></MemoryRouter></I18nProvider>}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><ThemeProvider><RootTooltipProvider><Fixture/></RootTooltipProvider></ThemeProvider></QueryClientProvider>)
`)
const output=path.join(root,'renderer')
await build({root:desktop,logLevel:'warn',build:{outDir:output,emptyOutDir:true,manifest:'manifest.json',reportCompressedSize:false,minify:false,rolldownOptions:{input:entry}}})
const manifest=JSON.parse(await fs.readFile(path.join(output,'manifest.json'),'utf8'))
const built=Object.values(manifest).find(item=>item.isEntry)
await fs.writeFile(path.join(output,'index.html'),'<!doctype html><html data-hermes-theme="uniwork"><meta charset="utf-8">'+(built.css||[]).map(name=>`<link rel="stylesheet" href="./${name}">`).join('')+`<body style="margin:0"><div id="root"></div><script type="module" src="./${built.file}"></script></body></html>`)
const server=await preview({root:desktop,logLevel:'error',build:{outDir:output},preview:{host:'127.0.0.1',port:0,open:false}})
let browser
try {
 browser=await chromium.launch({headless:true,channel:'msedge'})
 const page=await browser.newPage({viewport:{width:1040,height:712}})
 const errors=[]
 page.on('pageerror',error=>{errors.push(error.message);console.log(error.message)})
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
 await page.locator('.settings-redesign').waitFor({timeout:5000}).catch(async error=>{await page.screenshot({path:path.join(root,'error.png')});console.log(root);throw error})
 await page.screenshot({path:path.join(root,'settings-light.png')})
 await page.evaluate(()=>window.setFixtureMode('dark'))
 await page.waitForTimeout(200)
 await page.screenshot({path:path.join(root,'settings-dark.png')})
 await page.setViewportSize({width:700,height:650})
 await page.screenshot({path:path.join(root,'settings-narrow.png')})
 if(errors.length) throw new Error(errors.join('\n'))
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)
 if(overflow) throw new Error('Settings overflow horizontally')
 console.log(JSON.stringify({root,errors}))
}finally {await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve))}
