import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, test } from 'vitest'

import { pdfjsAssets } from './pdfjs-assets.mjs'

const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const base = `assets/pdfjs-${version}/`
const browserBuild = process.env.VITE_HERMES_BROWSER_BUILD

afterEach(() => {
  if (browserBuild === undefined) delete process.env.VITE_HERMES_BROWSER_BUILD
  else process.env.VITE_HERMES_BROWSER_BUILD = browserBuild
})

function emitted() {
  const files = new Map()

  pdfjsAssets().generateBundle.call({ emitFile: asset => files.set(asset.fileName, asset.source) })

  return files
}

test('the browser build publishes the worker and the files pdf.js loads by name', () => {
  process.env.VITE_HERMES_BROWSER_BUILD = '1'

  const files = emitted()

  // The worker as .js (a module worker served as anything but JavaScript does not start).
  assert.deepEqual(
    files.get(`${base}pdf.worker.js`),
    fs.readFileSync(path.join(root, 'legacy/build/pdf.worker.min.mjs'))
  )
  // Chinese text in fonts the PDF does not embed, the standard fonts, the image decoders, the CMYK profile.
  for (const name of [
    'cmaps/UniGB-UCS2-H.bcmap',
    'standard_fonts/FoxitSerif.pfb',
    'wasm/openjpeg.wasm',
    'iccs/CGATS001Compat-v2-micro.icc'
  ]) {
    assert.ok(files.has(base + name), name)
  }
  assert.ok([...files.keys()].every(name => name.startsWith(base)))
})

test('the desktop build publishes none of them', () => {
  delete process.env.VITE_HERMES_BROWSER_BUILD

  assert.equal(emitted().size, 0)
})

test('the dev server serves them from the package', () => {
  let mounted
  const server = { middlewares: { use: (route, handler) => (mounted = { handler, route }) } }

  pdfjsAssets().configureServer(server)
  assert.equal(mounted.route, `/${base}`)

  const serve = url => {
    const headers = {}
    let passed = false
    const res = { pipe: () => res, setHeader: (key, value) => (headers[key] = value) }
    const stream = { pipe: () => undefined }
    const original = fs.createReadStream

    fs.createReadStream = () => stream

    try {
      mounted.handler({ url }, res, () => (passed = true))
    } finally {
      fs.createReadStream = original
    }

    return { headers, passed }
  }

  assert.deepEqual(serve('/pdf.worker.js'), { headers: { 'Content-Type': 'text/javascript' }, passed: false })
  assert.deepEqual(serve('/wasm/openjpeg.wasm?v=1'), { headers: { 'Content-Type': 'application/wasm' }, passed: false })
  assert.deepEqual(serve('/cmaps/UniGB-UCS2-H.bcmap'), {
    headers: { 'Content-Type': 'application/octet-stream' },
    passed: false
  })
  assert.deepEqual(serve('/../package.json'), { headers: {}, passed: true })
})
