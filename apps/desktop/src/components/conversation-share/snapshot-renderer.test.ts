import { describe, expect, it } from 'vitest'

import { sanitizeShareContent } from './snapshot-renderer'

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
