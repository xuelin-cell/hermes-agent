import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { _electron as electron, expect } from '@playwright/test'
import { build as bundle } from 'esbuild'
import electronPath from 'electron'
import { build as buildRenderer, preview } from 'vite'

const desktop = path.resolve(import.meta.dirname, '..')

/** 找到 Chromium 原生进度条，用真实鼠标拖动验证交互，不靠修改 currentTime 代替。 */
async function dragPlaybackTimeline(page, player) {
  await player.hover()
  const cdp = await page.context().newCDPSession(page)
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
    // 原生控件在浏览器自己的 Shadow DOM 中，按实际节点用途定位。
    function findTimeline(node) {
      if (node.attributes?.includes('-webkit-media-controls-timeline')) return node
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
        const found = findTimeline(child)
        if (found) return found
      }
    }
    const timeline = findTimeline(root)
    assert.ok(timeline, 'Chromium native timeline is missing')
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: timeline.nodeId })
    const [left, top, right, , , bottom] = model.content
    const ratio = await player.evaluate(media => media.currentTime / media.duration)
    const y = (top + bottom) / 2
    await page.mouse.move(left + (right - left) * ratio, y)
    await page.mouse.down()
    await page.mouse.move(left + (right - left) * 0.75, y, { steps: 5 })
    await page.mouse.up()
    console.log('原生进度条拖动：' + JSON.stringify({ bounds: model.content, result: await player.evaluate(media => ({ current: media.currentTime, duration: media.duration, seeking: media.seeking })) }))
    await expect.poll(() => player.evaluate(media => !media.seeking && Math.abs(media.currentTime / media.duration - 0.75) < 0.05)).toBe(true)
  } finally {
    await cdp.detach()
  }
}

/** 生成独立的音视频样例，只调用指定的 FFmpeg，不下载或安装工具。 */
async function prepareMedia(root) {
  const samples = [
    ['sample.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-c:a', 'libmp3lame']],
    ['sample.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']]
  ]
  for (const [name, options] of samples) {
    const result = spawnSync(process.env.HERMES_PREVIEW_TEST_FFMPEG || 'ffmpeg',
      ['-nostdin', '-y', '-loglevel', 'error', ...options, '-t', '12', path.join(root, name)],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    assert.equal(result.status, 0, String(result.error || result.stderr))
  }
  await writeFile(path.join(root, 'broken.mp4'), 'not a media file')
}

/** 真实组件、preload 与媒体协议共用隔离目录，不启动 Hermes 或使用用户窗口。 */
async function prepareFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-file-preview-'))
  await prepareMedia(root)
  // 绝对模块路径以 JSON 字符串写入独立入口，避免路径转义错误。
  const sourcePath = relative => JSON.stringify(path.join(desktop, relative).replaceAll('\\', '/'))
  const entry = path.join(root, 'fixture.jsx')
  await writeFile(entry, `
    import ${sourcePath('src/styles.css')}
    import { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { I18nProvider } from ${sourcePath('src/i18n/context.tsx')}
    import { FormatPreview } from ${sourcePath('src/app/chat/right-rail/formats/format-preview.tsx')}
    const files = ${JSON.stringify(['sample.mp3', 'sample.mp4', 'broken.mp4'].map(name => ({
      kind: 'file', label: name, path: path.join(root, name), previewKind: 'binary',
      source: path.join(root, name), url: 'file://' + path.join(root, name)
    })))}
    // 测试按钮只选择正式文件目标，播放器由产品组件创建。
    function Fixture() {
      const [target, select] = useState(files[0])
      return <I18nProvider configClient={null} initialLocale="zh">
        <div style={{height:'100vh',display:'flex',flexDirection:'column'}}>
          <nav>{files.map(file => <button key={file.path} onClick={() => select(file)}>{file.label}</button>)}</nav>
          <div style={{position:'relative',flex:1,minHeight:0}}><FormatPreview reloadKey={0} target={target}/></div>
        </div>
      </I18nProvider>
    }
    createRoot(document.getElementById('root')).render(<Fixture />)
  `)
  const output = path.join(root, 'renderer')
  console.log('构建独立预览页面：' + root)
  // 使用正式生产配置生成独立入口，避免开发服务首次扫描整张依赖图。
  await buildRenderer({
    root: desktop, logLevel: 'warn',
    build: { outDir: output, emptyOutDir: true, manifest: 'renderer-manifest.json',
      reportCompressedSize: false, rolldownOptions: { input: entry } }
  })
  const manifest = JSON.parse(await readFile(path.join(output, 'renderer-manifest.json'), 'utf8'))
  const entryBundle = Object.values(manifest).find(item => item.isEntry)
  const links = (entryBundle.css || []).map(file => `<link rel="stylesheet" href="./${file}">`).join('')
  await writeFile(path.join(output, 'index.html'), `<html><head><meta charset="UTF-8">${links}</head><body><div id="root"></div><script type="module" src="./${entryBundle.file}"></script></body></html>`)
  const server = await preview({ root: desktop, logLevel: 'warn', build: { outDir: output },
    preview: { host: '127.0.0.1', port: 0, strictPort: false, open: false } })
  // 只关闭本夹具创建的服务，不影响用户已有的开发端口。
  const close = () => new Promise(resolve => server.httpServer.close(resolve))
  try {
    await bundle({ entryPoints: [path.join(desktop, 'electron/preload.ts')], bundle: true,
      platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(root, 'preload.cjs') })
    await bundle({ stdin: { contents: `
      import { app, BrowserWindow, ipcMain, protocol, session } from 'electron'
      import { createMediaProtocolHandler, MEDIA_PROTOCOL } from './electron/media-protocol'
      import { fetchLocalMedia } from './electron/media-range'
      import { resolveReadableFileForIpc } from './electron/hardening'
      import { resolveMediaStreamFile } from './electron/local-read-path'
      app.disableHardwareAcceleration()
      app.setPath('userData', ${JSON.stringify(path.join(root, 'user-data'))})
      protocol.registerSchemesAsPrivileged([{scheme:MEDIA_PROTOCOL,privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}])
      globalThis.previewProbe = {ranges:[], reveals:[]}
      for (const channel of ['hermes:translucency:support', 'hermes:hud:windowing', 'hermes:feature-flags', 'hermes:skin:local']) {
        ipcMain.on(channel, event => { event.returnValue = {} })
      }
      ipcMain.handle('hermes:fs:reveal', (_event, file) => { globalThis.previewProbe.reveals.push(file); return true })
      app.whenReady().then(() => {
        const partition = session.fromPartition('persist:file-preview-fixture')
        partition.protocol.handle(MEDIA_PROTOCOL, createMediaProtocolHandler({
          ensureRemoteBearer: async () => null,
          fetchLocal: async (file, headers, method) => {
            const response = await fetchLocalMedia(file, headers, method)
            globalThis.previewProbe.ranges.push({file,method,range:headers.get('range'),status:response.status})
            return response
          },
          fetchRemote: async () => { throw new Error('No remote fixture') },
          fetchRemoteWithCookies: async () => { throw new Error('No remote fixture') },
          resolveRemoteConnection: async () => { throw new Error('No remote fixture') },
          resolveLocalFile: async file => (await resolveReadableFileForIpc(resolveMediaStreamFile(file), {purpose:'Media stream'})).resolvedPath
        }))
        const window = new BrowserWindow({show:false,width:640,height:480,webPreferences:{
          session:partition,preload:${JSON.stringify(path.join(root, 'preload.cjs'))},contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false
        }})
        window.loadURL('about:blank')
      })
      app.on('window-all-closed', () => app.quit())
    `, resolveDir: desktop, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
      external: ['electron'], outfile: path.join(root, 'main.cjs') })
    return { root, close, url: `http://127.0.0.1:${server.httpServer.address().port}/` }
  } catch (error) {
    await close()
    throw error
  }
}

test('真实 Electron 音视频能播放、跳转进度，失败保留原文件出口', { timeout: 240_000 }, async () => {
  const fixture = await prepareFixture()
  let instance
  try {
    const env = { ...process.env, HERMES_HOME: path.join(fixture.root, 'hermes-home') }
    delete env.ELECTRON_RUN_AS_NODE
    instance = await electron.launch({ executablePath: electronPath, args: [path.join(fixture.root, 'main.cjs')], cwd: desktop, env })
    console.log('独立 Electron 已启动')
    const page = await instance.firstWindow()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(fixture.url)
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
    console.log('独立预览页面已加载')
    for (const [name, tag] of [['sample.mp3', 'audio'], ['sample.mp4', 'video']]) {
      await page.getByRole('button', { name, exact: true }).click()
      const player = page.locator(tag)
      await player.waitFor({ timeout: 90_000 })
      await expect.poll(() => player.evaluate(media => media.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
      assert.equal(await player.evaluate(media => media.controls && !media.autoplay && media.duration > 10), true)
      await player.evaluate(async media => { media.muted = true; await media.play() })
      await expect.poll(() => player.evaluate(media => media.currentTime)).toBeGreaterThan(0.2)
      await player.evaluate(media => { media.pause(); media.currentTime = 6 })
      await expect.poll(() => player.evaluate(media => !media.seeking && media.currentTime >= 5.9 && media.seekable.end(0) > 6)).toBe(true)
      await dragPlaybackTimeline(page, player)
      const range = await player.evaluate(async media => {
        const response = await fetch(media.src, { headers: { Range: 'bytes=200-499' } })
        return { status: response.status, length: (await response.arrayBuffer()).byteLength }
      })
      assert.deepEqual(range, { status: 206, length: 300 })
      console.log(name + ' 实际播放、拖动进度与 Range 检查通过')
      await page.screenshot({ path: path.join(fixture.root, `${tag}.png`) })
    }
    await page.getByRole('button', { name: 'broken.mp4', exact: true }).click()
    const reveal = page.getByRole('button', { name: '打开所在文件夹', exact: true })
    await expect(reveal).toBeVisible({ timeout: 30_000 })
    await reveal.click()
    await expect.poll(() => instance.evaluate(() => globalThis.previewProbe.reveals)).toEqual([path.join(fixture.root, 'broken.mp4')])
    const probe = await instance.evaluate(() => globalThis.previewProbe)
    assert.deepEqual(probe.reveals, [path.join(fixture.root, 'broken.mp4')])
    assert.equal(probe.ranges.some(request => request.status === 206 && request.range === 'bytes=200-499'), true)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: path.join(fixture.root, 'failure.png') })
    console.log('音视频独立夹具与截图：' + fixture.root)
  } finally {
    await instance?.close()
    await fixture.close()
  }
})
