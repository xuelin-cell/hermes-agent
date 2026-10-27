import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BrowserWindow, dialog, ipcMain, session, type Session } from 'electron'

import { type PreviewExport, type PreviewExportResult, wordDocument } from '../../shared/src/preview-export'

import { isDesktopRendererSender } from './desktop-renderer-sender'

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
