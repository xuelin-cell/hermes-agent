import { describe, expect, it, vi } from 'vitest'

import { resourceBlob, sanitizeShareContent } from './snapshot-renderer'

describe('公开 HTML 静态边界', () => {
  it('保留 Markdown、过程和图表的语义，但移除执行能力和本机、带凭证链接', () => {
    const output = sanitizeShareContent(`<article><h1>你好</h1><table><tbody><tr><td>完整表格</td></tr></tbody></table>
      <details><summary>过程</summary><p>只读内容</p></details><pre><code>const x = 1</code></pre>
      <a href="https://example.com/report">正常链接</a><a href="file:///private/secret">本机</a>
      <a href="https://example.com/?access_token=private">带凭据</a><script>alert(1)</script>
      <iframe src="https://example.com"></iframe><button onclick="alert(1)">发布</button>
      <p onclick="alert(1)" data-private="secret">正文</p><svg><path d="M0 0 L1 1" /></svg></article>`)

    expect(output).toContain('完整表格')
    expect(output).toContain('<details>')
    expect(output).toContain('const x = 1')
    expect(output).toContain('href="https://example.com/report"')
    expect(output).toContain('<svg>')
    expect(output).not.toMatch(/script|iframe|onclick|data-private|file:\/\/|access_token|<button/)
  })

  it('图片必须完整内嵌，不能静默发布依赖临时地址或本机文件的页面', () => {
    expect(() => sanitizeShareContent('<img src="blob:https://app.example/id">')).toThrow(/embedded/)
    expect(() => sanitizeShareContent('<img src="https://example.com/image.png">')).toThrow(/embedded/)
    const data = 'data:image/png;base64,aGVsbG8='
    expect(sanitizeShareContent(`<img src="${data}" alt="图片">`)).toContain(data)
  })
})

it('uses the cloud login cookie only for same-origin bundled fonts and styles', async () => {
  const original = document.documentElement.dataset.hermesBrowser
  document.documentElement.dataset.hermesBrowser = '1'
  const fetcher = vi.fn<typeof fetch>(async () => new Response('font', { headers: { 'content-type': 'font/woff2' } }))
  vi.stubGlobal('fetch', fetcher)
  try {
    const assets = new URL(`${import.meta.env.BASE_URL || '/'}assets/`, location.href)
    for (const name of ['font.woff2', 'main.css']) {
      await resourceBlob(new URL(name, assets).href, new AbortController().signal, false)
      expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ credentials: 'same-origin', redirect: 'error' })
    }
    for (const url of ['https://external.example/font.woff2', new URL('/__entry/font.woff2', location.href).href,
      new URL('nested%2f..%2fsecret.woff2', assets).href]) {
      await resourceBlob(url, new AbortController().signal, false)
      expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
    }
    fetcher.mockImplementationOnce(async () => new Response('image', { headers: { 'content-type': 'image/png' } }))
    await resourceBlob('https://external.example/image.png', new AbortController().signal, true)
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ credentials: 'omit' })
    delete document.documentElement.dataset.hermesBrowser
    await resourceBlob(new URL('font.woff2', assets).href, new AbortController().signal, false)
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ credentials: 'omit' })
  } finally {
    if (original === undefined) delete document.documentElement.dataset.hermesBrowser
    else document.documentElement.dataset.hermesBrowser = original
    vi.unstubAllGlobals()
  }
})
