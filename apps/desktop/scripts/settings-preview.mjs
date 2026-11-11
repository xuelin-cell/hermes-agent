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
import {HashRouter} from ${JSON.stringify(resolve('react-router'))}
import {QueryClient,QueryClientProvider} from ${JSON.stringify(resolve('@tanstack/react-query').replace('.cjs', '.js'))}
import {I18nProvider} from ${source('src/i18n/context.tsx')}
import {ThemeProvider} from ${source('src/themes/context.tsx')}
import {RootTooltipProvider} from ${source('src/components/ui/tooltip.tsx')}
import {SettingsView} from ${source('src/app/settings/index.tsx')}
import ${source('src/styles.css')}
let config={display:{language:'zh-CN'},approvals:{mode:'smart',timeout:300},plugins:{entries:{'uniwork-telemetry':{settings:{enabled:false}}}},mcp_servers:{'UniWork-Drive':{uniwork_managed:'uniwork.desktop.drive.v1',enabled:true}}}
const api=async request=>{
 const p=request.path||'';
 if(p.includes('/config/schema'))return {fields:{'approvals.mode':{type:'select',options:['manual','smart','off']},'approvals.timeout':{type:'number'}}};
 if(p.startsWith('/api/config')){if(request.method==='PUT')config=request.body?.config||config;return structuredClone(config)}
 if(p.includes('custom-endpoints'))return {endpoints:[]};
 if(p.includes('/profiles')&&p.includes('sessions'))return {sessions:[],total:0,profiles:[],errors:[]};
 if(p.includes('/profiles'))return {profiles:[],active:'default'};
 if(p.includes('platforms'))return {platforms:[]};
 if(p.includes('/sessions'))return {sessions:[],total:0};
 if(p.includes('/models'))return {models:[]};
 return {ok:true,enabled:false,logged_in:false};
}
window.hermesDesktop=new Proxy({api,settings:{getDefaultProjectDir:async()=>({dir:null,defaultLabel:'预览工作空间'}),pickDefaultProjectDir:async()=>({canceled:true})},setKeepAwake:()=>{},createConversationFolder:async()=>({}),getMaasAccount:async()=>null,openExternal:async()=>{},revealLogs:async()=>{}},{get:(target,name)=>name in target?target[name]:String(name).startsWith('on')?()=>()=>{}:async()=>({ok:true})})
function App(){return <I18nProvider><HashRouter><div style={{height:'100vh',background:'#eef1f6'}}><p style={{padding:20,color:'#686f82'}}>设置页面样式预览 · 模拟数据</p><SettingsView onClose={()=>{location.hash='/settings';alert('预览：关闭按钮已触发')}}/></div></HashRouter></I18nProvider>}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ThemeProvider><RootTooltipProvider><App/></RootTooltipProvider></ThemeProvider></QueryClientProvider>)
`)

const output=path.join(root,'renderer')
await build({root:desktop,logLevel:'warn',build:{outDir:output,emptyOutDir:true,manifest:'manifest.json',reportCompressedSize:false,minify:false,rolldownOptions:{input:entry}}})
const manifest=JSON.parse(await fs.readFile(path.join(output,'manifest.json'),'utf8'))
const built=Object.values(manifest).find(item=>item.isEntry)
await fs.writeFile(path.join(output,'index.html'),'<!doctype html><html data-hermes-theme="uniwork"><meta charset="utf-8">'+(built.css||[]).map(name=>`<link rel="stylesheet" href="./${name}">`).join('')+`<body style="margin:0"><div id="root"></div><script type="module" src="./${built.file}"></script></body></html>`)
const server=await preview({root:desktop,logLevel:'error',build:{outDir:output},preview:{host:'127.0.0.1',port:4186,strictPort:false,open:false}})

const url=`http://127.0.0.1:${server.httpServer.address().port}/#/settings`
console.log('SETTINGS_PREVIEW_URL='+url)
await new Promise(()=>{})
