import remarkParse from 'remark-parse'
import { unified } from 'unified'
// Regression for #96657: an unquoted MEDIA: path with interior spaces rendered
// a card for the text before the first space and left the rest as prose.
import { describe, expect, it } from 'vitest'

import { localPreviewTarget } from '@/lib/local-preview'
import { mediaMarkdownHref } from '@/lib/media'

import { appendAssistantTextPart, chatMessageText, mediaTagValues, renderMediaTags } from './parts'

const SPACED = '/home/hermes/Morten - Nobly Kickoff - Opening and cue cards EN.docx'
const CARD = `[File: Morten - Nobly Kickoff - Opening and cue cards EN.docx](#media:${encodeURIComponent(SPACED)})`

describe('MEDIA 作为 Markdown 链接目标', () => {
  it('混合行内、独立行和包装时保持原始顺序，不重复解析已转换的路径', () => {
    const content = '见 MEDIA:/tmp/first.pdf\nMEDIA:/tmp/second.pdf\n[文件](MEDIA:/tmp/third.pdf)'
    expect(mediaTagValues(content)).toEqual(['/tmp/first.pdf', '/tmp/second.pdf', '/tmp/third.pdf'])
  })
  it.each([
    ['![小狗](MEDIA:/C:/a/b.png)', '/C:/a/b.png'],
    ['![小狗](MEDIA:/C:\\a\\b.png)', '/C:\\a\\b.png'],
    ['[说明](MEDIA:C:\\a\\b.mp4)', 'C:\\a\\b.mp4'],
    ['![说明](<MEDIA:/tmp/a b.wav>)', '/tmp/a b.wav'],
    ['[说明](MEDIA:/tmp/a b.mp3)', '/tmp/a b.mp3'],
    ['![说明](MEDIA:/tmp/a b.png)', '/tmp/a b.png'],
    ['![报告](MEDIA:C:/tmp/报告 (1).docx)', 'C:/tmp/报告 (1).docx'],
    ['[报告](MEDIA:C:\\tmp\\报告 (草稿 (1)).pptx)', 'C:\\tmp\\报告 (草稿 (1)).pptx'],
    ['[报告](<MEDIA:/tmp/报告 (1).docx>)', '/tmp/报告 (1).docx'],
    ['[报告](MEDIA:"/tmp/报告 (1).docx")', '"/tmp/报告 (1).docx"']
  ])('完整消费包装，显示与独立 MEDIA 行相同：%s', (source, target) => {
    expect(renderMediaTags(source)).toBe(renderMediaTags(`MEDIA:${target}`))
    expect(renderMediaTags(`开始 ${source} 结束`)).toBe(`开始 ${renderMediaTags(`MEDIA:${target}`)} 结束`)
    expect(mediaTagValues(source)).toEqual([target])
    expect(unified().use(remarkParse).parse(renderMediaTags(source))).toMatchObject({
      children: [
        { type: 'paragraph', children: [{ type: 'link', url: mediaMarkdownHref(target.replace(/^"|"$/g, '')) }] }
      ]
    })
    expect(mediaTagValues(`MEDIA:/tmp/first.pdf\n${source}\nMEDIA:/tmp/last.pdf`)).toEqual([
      '/tmp/first.pdf',
      target,
      '/tmp/last.pdf'
    ])
  })
})

describe('中文说明与文件交付路径的边界', () => {
  it('将中文说明留在正文，预览只读取实际文件路径', () => {
    for (const path of ['你好.md', '/workspace/你好.md', 'outputs/你好.html']) {
      const prose = '，内容为「你好」。'
      const text = `已创建：\nMEDIA:${path}${prose}`
      expect(mediaTagValues(text)).toEqual([path])
      expect(renderMediaTags(text)).toBe(
        `已创建：\n[File: ${path.split('/').pop()}](#media:${encodeURIComponent(path)})${prose}`
      )
      expect(localPreviewTarget(mediaTagValues(text)[0], '/workspace')?.path).toBe(
        path.startsWith('/') ? path : `/workspace/${path}`
      )
    }
  })

  it('带引号的真实文件名可以包含中文标点', () => {
    const path = '/workspace/你好.md，最终版本.md'
    expect(mediaTagValues(`MEDIA:"${path}"，请查看。`)).toEqual([`"${path}"`])
    expect(renderMediaTags(`MEDIA:"${path}"，请查看。`)).toBe(
      `[File: 你好.md，最终版本.md](#media:${encodeURIComponent(path)})，请查看。`
    )
  })
})

describe('renderMediaTags with interior spaces', () => {
  it('keeps the whole spaced path in one card on every surface that reads MEDIA tags', () => {
    expect(renderMediaTags(`MEDIA:${SPACED}`)).toBe(CARD)
    expect(renderMediaTags(`Here you go: MEDIA:${SPACED} — enjoy`)).toBe(`Here you go: ${CARD} — enjoy`)
    expect(renderMediaTags('MEDIA:C:\\Users\\Morten\\My Report.docx')).toBe(
      '[File: My Report.docx](#media:C%3A%5CUsers%5CMorten%5CMy%20Report.docx)'
    )
    expect(mediaTagValues(`ready\nMEDIA:${SPACED}\nMEDIA:/tmp/a.png`)).toEqual([SPACED, '/tmp/a.png'])
  })

  it('settles on the complete path when the stream splits inside it', () => {
    const chunks = ['ready\nMEDIA:/tmp/AI', ' Brain/re', 'port.pdf', '\nall done']
    let parts = appendAssistantTextPart([], chunks[0])

    // Mid-stream the truncated prefix may render as a card; the next delta must undo it.
    for (const chunk of chunks.slice(1)) {
      parts = appendAssistantTextPart(parts, chunk)
    }

    expect(chatMessageText({ id: 'a', parts, role: 'assistant' })).toBe(
      'ready\n[File: report.pdf](#media:%2Ftmp%2FAI%20Brain%2Freport.pdf)\nall done'
    )
  })
})

describe('inline-code MEDIA paths', () => {
  const card = (path: string) => `[File: ${path.split(/[/\\]/).pop()}](#media:${encodeURIComponent(path)})`

  it('does not swallow a trailing backtick on relative or unknown-extension paths', () => {
    expect(mediaTagValues('MEDIA:report.md` prose')).toEqual(['report.md'])
    expect(mediaTagValues('MEDIA:/tmp/file.unknown` prose')).toEqual(['/tmp/file.unknown'])
    expect(mediaTagValues('`MEDIA:notes.log` prose')).toEqual(['notes.log'])
    expect(mediaTagValues('MEDIA:draft.md`，打开复制')).toEqual(['draft.md'])
    expect(renderMediaTags('MEDIA:report.md` prose')).toBe(`${card('report.md')} prose`)
    expect(renderMediaTags('MEDIA:/tmp/file.unknown`，打开')).toBe(`${card('/tmp/file.unknown')}，打开`)
    expect(renderMediaTags('MEDIA:report.md`')).toBe(card('report.md'))
    expect(renderMediaTags('`MEDIA:/tmp/file.unknown`')).toBe(card('/tmp/file.unknown'))
    expect(mediaTagValues("MEDIA:/tmp/john's.unknown x")).toEqual(["/tmp/john's.unknown"])
    expect(renderMediaTags('MEDIA:"/tmp/a b.md" x')).toBe(`${card('/tmp/a b.md')} x`)
    expect(mediaTagValues('MEDIA:/tmp/file.unknown" prose')).toEqual(['/tmp/file.unknown'])
  })

  it('keeps absolute markdown backtick wraps and leaves the anchored branch intact', () => {
    expect(mediaTagValues('MEDIA:/Users/a/report.md` followed by prose')).toEqual(['/Users/a/report.md'])
    expect(mediaTagValues('MEDIA:/Users/a/draft.md`，打开复制')).toEqual(['/Users/a/draft.md'])
    expect(mediaTagValues('`MEDIA:/Users/a/report.md` prose')).toEqual(['/Users/a/report.md'])
    expect(renderMediaTags('`MEDIA:/dir with space/f.md`')).toBe(card('/dir with space/f.md'))
    expect(mediaTagValues("MEDIA:/tmp/john's.md x")).toEqual(["/tmp/john's.md"])
    expect(renderMediaTags("MEDIA:'/tmp/a b.md' x")).toBe(`${card('/tmp/a b.md')} x`)
    expect(renderMediaTags('MEDIA:/tmp/a.png')).toBe('[Image: a.png](#media:%2Ftmp%2Fa.png)')
  })
})
