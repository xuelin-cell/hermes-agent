import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BrowserWindow, dialog, ipcMain, session, type Session } from 'electron'
// 只用同步纯 JS 入口，不引入 Node Worker 的 createRequire 初始化，避免与 Electron 打包横幅重名。
import { strToU8, zipSync } from 'fflate/browser'

import { isDesktopRendererSender } from './desktop-renderer-sender'

export interface PreviewExport {
  format: 'md' | 'pdf' | 'docx'
  name: string
  content: string
}
export type PreviewExportResult = { status: 'saved' | 'cancelled' | 'failed' }

/** 沿用 UniWork 的 OOXML altChunk 模式，用现有 ZIP 库封装 HTML 和内嵌图片，不依赖本机 Office。 */
export function wordDocument(html: string): Uint8Array {
  const boundary = '----hermes-preview-' + crypto.randomUUID()
  const images: string[] = []

  const body = html.replace(
    /(<img\b[^>]*?\ssrc=)(['"])data:(image\/[\w.+-]+);base64,([^'"]+)\2/gi,
    (_match, prefix, quote, mime, data) => {
      const location = `file:///preview/image${images.length}`
      images.push(
        `--${boundary}\r\nContent-Type: ${mime}\r\nContent-Transfer-Encoding: base64\r\nContent-Location: ${location}\r\n\r\n${data}\r\n`
      )

      return `${prefix}${quote}${location}${quote}`
    }
  )

  const mht = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${boundary}"; type="text/html"\r\n\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\nContent-Location: file:///preview/document.html\r\n\r\n${Buffer.from(body).toString('base64').replace(/.{76}/g, '$&\r\n')}\r\n${images.join('')}--${boundary}--`
  const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

  const files = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="mht" ContentType="message/rfc822"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${relationships}"><Relationship Id="document" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${relationships}"><Relationship Id="html" Type="${office}/aFChunk" Target="afchunk.mht"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${office}"><w:body><w:altChunk r:id="html"/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
    'word/afchunk.mht': mht
  }

  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])))
}

/** 在无凭据、无 preload、禁脚本和网络的临时窗口打印；超时或失败也销毁窗口与独立分区。 */
export async function previewPdf(html: string): Promise<Uint8Array> {
  const isolated = session.fromPartition('preview-export-' + crypto.randomUUID())
  let documentUrl: string | undefined
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({
      cancel: !details.url.startsWith('data:') && !(details.resourceType === 'mainFrame' && details.url === documentUrl)
    })
  )

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: isolated,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  let timer: ReturnType<typeof setTimeout> | undefined
  let directory: string | undefined

  try {
    return await Promise.race([
      (async () => {
        const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">`
        // 样式和字体内嵌后可能超过 Chromium 的 data URL 长度上限，只放行本轮主文档。
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-preview-export-'))
        const document = path.join(directory, 'document.html')
        documentUrl = pathToFileURL(document).href
        await fs.writeFile(document, csp + html, { encoding: 'utf8', mode: 0o600 })
        await window.loadURL(documentUrl)

        return window.webContents.printToPDF({ pageSize: 'A4', preferCSSPageSize: true, printBackground: true })
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Preview export timeout')), 30_000)
      })
    ])
  } finally {
    clearTimeout(timer)
    window.destroy()

    try {
      await isolated.clearStorageData()
    } finally {
      if (directory) {
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
  }
}

/** 只接受固定账号桌面主框架的导出，保存位置必须由原生对话框当次选择。 */
export function installPreviewExportIpc(
  accountSession: Session,
  rendererUrl: () => string,
  active: () => boolean
): void {
  ipcMain.handle('hermes:preview:export', async (event, input: PreviewExport): Promise<PreviewExportResult> => {
    /** 异步对话框和转换期间再次核对账号，退出后不继续写文件。 */
    const trusted = () => active() && isDesktopRendererSender(event, accountSession, rendererUrl())

    if (
      !trusted() ||
      !input ||
      !['md', 'pdf', 'docx'].includes(input.format) ||
      typeof input.name !== 'string' ||
      typeof input.content !== 'string' ||
      Buffer.byteLength(input.content) > 8 * 1024 * 1024
    ) {
      return { status: 'failed' }
    }

    try {
      const parent = BrowserWindow.fromWebContents(event.sender)!

      const name =
        path
          .basename(input.name.replaceAll('\\', '/'))
          .replace(/\.(md|markdown|mdx)$/i, '')
          .replace(/[<>:"|?*\p{Cc}]/gu, '_')
          .slice(0, 100) || 'document'

      const selected = await dialog.showSaveDialog(parent, {
        defaultPath: `${name}.${input.format}`,
        filters: [{ name: input.format.toUpperCase(), extensions: [input.format] }]
      })

      if (selected.canceled || !selected.filePath) {
        return { status: 'cancelled' }
      }

      if (!trusted()) {
        return { status: 'failed' }
      }

      const bytes =
        input.format === 'md'
          ? Buffer.from(input.content)
          : input.format === 'docx'
            ? wordDocument(input.content)
            : await previewPdf(input.content)

      if (!trusted()) {
        return { status: 'failed' }
      }

      await fs.writeFile(selected.filePath, bytes)

      return { status: 'saved' }
    } catch {
      return { status: 'failed' }
    }
  })
}
