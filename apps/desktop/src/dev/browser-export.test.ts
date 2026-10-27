import { strFromU8, unzipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'

import { storeBrowserLogin } from '../../../shared/src/browser-maas-auth.js'

import { browserExport } from './browser-export'

const login = (id: string) => storeBrowserLogin('/hermes', { maas_auth: {
  token: 'private-' + id, loginId: id, expiresAt: Date.now() + 120_000
} })

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('Markdown 和 Word 复用真实封装后交浏览器下载，不访问上游、不改源文件', async () => {
  login('alice')
  const blobs: Blob[] = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob);

 return 'blob:export' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const names: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download) })
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  const save = browserExport('/hermes', '/hermes/__hermes_backend')
  expect(await save({ format: 'md', name: '../中文.md', content: '# 中文' })).toEqual({ status: 'handed-off' })
  expect(await blobs[0].text()).toBe('# 中文')
  expect(await save({ format: 'docx', name: '中文.md', content: '<h1>中文</h1>' })).toEqual({ status: 'handed-off' })
  const files = unzipSync(new Uint8Array(await blobs[1].arrayBuffer()))
  expect(strFromU8(files['word/document.xml'])).toContain('w:altChunk')
  const mht = strFromU8(files['word/afchunk.mht'])
  const payload = mht.split('Content-Location: file:///preview/document.html\r\n\r\n')[1].split('\r\n--')[0]
  expect(new TextDecoder().decode(Uint8Array.from(atob(payload.replaceAll('\r\n', '')), char => char.charCodeAt(0)))).toBe('<h1>中文</h1>')
  expect(names).toEqual(['中文.md', '中文.docx'])
  expect(request).not.toHaveBeenCalled()
})

it('PDF 仅发往同源实例，账号切换、错误响应和超限不会交付文件', async () => {
  login('alice')
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const request = vi.fn(async (_url: string, _options: RequestInit) => new Response('%PDF-fixture', { headers: { 'Content-Type': 'application/pdf' } }))
  vi.stubGlobal('fetch', request)
  const save = browserExport('/hermes', '/hermes/__hermes_backend')
  const input = { format: 'pdf' as const, name: 'report.md', content: '<p>rendered snapshot</p>' }
  expect(await save(input)).toEqual({ status: 'handed-off' })
  const [url, options] = request.mock.calls[0]
  expect(url).toBe('/hermes/__hermes_backend/__mt_user/preview-export')
  expect(options.credentials).toBe('same-origin')
  expect(new Headers(options.headers).has('Authorization')).toBe(false)
  expect(JSON.parse(options.body as string)).toEqual({ content: input.content })
  request.mockImplementationOnce(async () => { login('bob');

 return new Response('%PDF-fixture', { headers: { 'Content-Type': 'application/pdf' } }) })
  expect(await save(input)).toEqual({ status: 'failed' })
  request.mockResolvedValueOnce(new Response('not a pdf', { headers: { 'Content-Type': 'application/pdf' } }))
  expect(await save(input)).toEqual({ status: 'failed' })
  expect(await save({ ...input, content: 'x'.repeat(8 * 1024 * 1024 + 1) })).toEqual({ status: 'failed' })
  expect(anchor).toHaveBeenCalledTimes(1)
})
