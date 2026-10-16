import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { Plugin } from 'vite'

/** 开发与发行使用同一份本机 PDF.js 字体、字符映射和解码资源，不依赖 CDN。 */
export function pdfAssets(): Plugin {
  const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const files = new Map<string, string>()

  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    for (const name of fs.readdirSync(path.join(root, directory))) {
      const file = path.join(root, directory, name)

      if (fs.statSync(file).isFile()) {
        files.set(`${directory}/${name}`, file)
      }
    }
  }

  return {
    name: 'hermes:pdf-assets',
    /** 只提供登记过的资源，不把 URL 拼成任意磁盘路径。 */
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const file = files.get((req.url || '').split('?')[0].replace(/^\//, ''))

        if (!file) {
          return next()
        }

        fs.readFile(file, (error, data) => {
          if (error) {
            return next(error)
          }

          res.setHeader(
            'Content-Type',
            file.endsWith('.wasm')
              ? 'application/wasm'
              : file.endsWith('.js')
                ? 'text/javascript'
                : 'application/octet-stream'
          )
          res.end(data)
        })
      })
    },
    /** 资源作为正式构建产物，保持相对目录以支持安装后的 file 页面。 */
    generateBundle() {
      for (const [name, file] of files) {
        this.emitFile({ type: 'asset', fileName: `pdfjs/${name}`, source: fs.readFileSync(file) })
      }
    }
  }
}
