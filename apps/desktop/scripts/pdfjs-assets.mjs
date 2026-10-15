// The browser build's PDF viewer (src/app/chat/right-rail/pdf-preview.tsx) runs
// pdf.js, which starts its worker from a URL and fetches, on demand, the files a
// PDF may need: CMaps (CJK text in fonts the file does not embed), the standard
// fonts, image decoders (wasm) and a CMYK colour profile. It asks for them by
// name under one base URL, so they cannot take the bundler's hashed names: they
// are emitted as they are under assets/pdfjs-<version>/ (a new pdf.js version
// gets a new folder, so the long cache on assets/ stays safe) and served from
// node_modules by the dev server. The worker is emitted as .js: nginx's MIME
// types do not know .mjs, and a module worker served as anything but JavaScript
// does not start. Only the browser build (VITE_HERMES_BROWSER_BUILD=1) emits
// them; the desktop app does not show PDFs this way.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const DATA_DIRS = ['cmaps', 'iccs', 'standard_fonts', 'wasm']
const WORKER = 'legacy/build/pdf.worker.min.mjs'

const CONTENT_TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm' }

export function pdfjsAssets() {
  const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const base = `assets/pdfjs-${version}/`

  // Published path (under `base`) -> file in the package.
  const files = () =>
    new Map([
      ['pdf.worker.js', path.join(root, WORKER)],
      ...DATA_DIRS.flatMap(dir =>
        fs.readdirSync(path.join(root, dir)).map(name => [`${dir}/${name}`, path.join(root, dir, name)])
      )
    ])

  return {
    name: 'hermes:pdfjs-assets',
    configureServer(server) {
      const served = files()

      server.middlewares.use(`/${base}`, (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\/+/, '')
        const file = served.get(name)

        if (!file) return next()
        res.setHeader('Content-Type', CONTENT_TYPES[path.extname(name)] ?? 'application/octet-stream')
        fs.createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      if (process.env.VITE_HERMES_BROWSER_BUILD !== '1') return
      for (const [name, file] of files()) {
        this.emitFile({ type: 'asset', fileName: base + name, source: fs.readFileSync(file) })
      }
    }
  }
}
