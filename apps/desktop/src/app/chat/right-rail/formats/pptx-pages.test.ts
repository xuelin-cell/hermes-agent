import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { cleanPresentation, fixRelationshipOrder, openPptxPages } from './pptx-pages'

const P =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
// 能闭合 HTML 属性的字体名与颜色；pptx-viewer 画表格时会把它们原样拼进 HTML。
const EVIL_FONT = 'x&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'
const EVIL_COLOR = '000000&quot; onmouseover=&quot;alert(1)'
const created: Blob[] = []

/** 按幻灯片正文生成最小 pptx，只含解析器必需的部件。 */
function deck(slides: string[]) {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
    ),
    'ppt/presentation.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${P}><p:sldIdLst>${slides
        .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`)
        .join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`
    ),
    'ppt/_rels/presentation.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
        .map(
          (_, index) => `<Relationship Id="rId${index + 1}" Type="${REL}/slide" Target="slides/slide${index + 1}.xml"/>`
        )
        .join('')}</Relationships>`
    )
  }

  slides.forEach((body, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`
    )
  })

  return zipSync(files).buffer as ArrayBuffer
}

/** 一个文本框。 */
function text(value: string) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="6096000" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="zh-CN" sz="2400"/><a:t>${value}</a:t></a:r></a:p></p:txBody></p:sp>`
}

/** 一个单元格的表格，字体名和颜色由调用方给出。 */
function table(font: string, color: string) {
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="2743200"/><a:ext cx="6096000" cy="914400"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="6096000"/></a:tblGrid><a:tr h="914400"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="zh-CN"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${font}"/></a:rPr><a:t>单元格 &lt;b&gt;</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
}

beforeEach(() => {
  created.length = 0
  let next = 0
  // jsdom 没有 blob 地址；记下内容，测试读回生成的 SVG。
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    created.push(blob as Blob)

    return `blob:test/${++next}`
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.head.innerHTML = ''
})

it('按页画出 SVG 图片，尺寸取自演示文稿', async () => {
  const pages = await openPptxPages(deck([text('第一页'), text('第二页')]))

  expect(pages.pages).toHaveLength(2)
  expect(pages.pages[0].width / pages.pages[0].height).toBeCloseTo(16 / 9)

  const url = await pages.renderPage(2)
  const svg = await created.at(-1)!.text()

  expect(created.at(-1)!.type).toBe('image/svg+xml;charset=utf-8')
  expect(svg).toContain('<svg')
  expect(svg).toContain('第二页')
  expect(pages.cachedPage(2)).toBe(url)
  expect(await pages.renderPage(2)).toBe(url)
  await expect(pages.renderPage(3)).rejects.toEqual({ code: 'unsupported' })

  await pages.dispose()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(url)
  await expect(pages.renderPage(1)).rejects.toEqual({ code: 'unavailable' })
})

it('表格里的字体名和颜色不能注入页面元素或事件', async () => {
  const pages = await openPptxPages(deck([table(EVIL_FONT, EVIL_COLOR)]))
  const before = document.querySelectorAll('img').length

  await pages.renderPage(1)
  const svg = await created.at(-1)!.text()

  expect(svg).toContain('单元格 &lt;b&gt;')
  expect(svg).not.toMatch(/<img|onerror|onmouseover/i)
  expect(document.querySelectorAll('img')).toHaveLength(before)
})

it('带空格的表格字体不再截断样式，生成的 SVG 是合法 XML', async () => {
  const pages = await openPptxPages(deck([table('Microsoft YaHei', 'C00000')]))

  await pages.renderPage(1)
  const svg = await created.at(-1)!.text()
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')

  expect(parsed.querySelector('parsererror')).toBeNull()
  expect(parsed.querySelector('span')!.getAttribute('style')).toContain('color: #C00000')
})

it('清理只改字体名和颜色，并能穿过 Map 和循环引用', () => {
  const run: Record<string, unknown> = { text: '"<保留>"', fontFamily: 'A"<b>;\\', color: { hex: '#12ab34' } }
  const bad = { hex: '#000000" x="' }

  const model = { slides: [{ runs: [run], fill: bad }], fonts: new Map([['f', { typeface: "Y'>" }]]) } as Record<
    string,
    unknown
  >

  model.self = model

  cleanPresentation(model)

  expect(run).toEqual({ text: '"<保留>"', fontFamily: 'Ab', color: { hex: '#12ab34' } })
  expect(bad.hex).toBe('#000000')
  expect((model.fonts as Map<string, { typeface: string }>).get('f')!.typeface).toBe('Y')
})

it('不是 pptx 或没有幻灯片时交给降级流程', async () => {
  await expect(openPptxPages(strToU8('not a zip').buffer as ArrayBuffer)).rejects.toEqual({ code: 'unavailable' })
  await expect(openPptxPages(deck([]))).rejects.toEqual({ code: 'unsupported' })
})

it('不在主页面留下内嵌字体样式', async () => {
  const style = document.createElement('style')
  style.id = 'pptx-embedded-fonts'
  document.head.append(style)

  await openPptxPages(deck([text('x')]))

  expect(document.getElementById('pptx-embedded-fonts')).toBeNull()
})

it('幻灯片关系排在母版前面时挪到最后，顺序本来就对的文件原样交给解析器', () => {
  const rels = (order: string[]) =>
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${order
      .map(
        (type, index) => `<Relationship Id="rId${index + 1}" Type="${REL}/${type}" Target="${type}${index + 1}.xml"/>`
      )
      .join('')}</Relationships>`

  const wrong = zipSync({
    'ppt/_rels/presentation.xml.rels': strToU8(rels(['slide', 'slide', 'slideMaster', 'theme'])),
    'ppt/slides/_rels/slide1.xml.rels': strToU8(rels(['slideLayout', 'image'])),
    'ppt/media/a.png': new Uint8Array([1, 2, 3])
  })

  const fixed = unzipSync(fixRelationshipOrder(wrong))
  const types = [...strFromU8(fixed['ppt/_rels/presentation.xml.rels']).matchAll(/Id="(rId\d)" Type="[^"]*\/(\w+)"/g)]

  expect(types.map(match => `${match[1]}:${match[2]}`)).toEqual([
    'rId3:slideMaster',
    'rId4:theme',
    'rId1:slide',
    'rId2:slide'
  ])
  expect(fixed['ppt/media/a.png']).toEqual(new Uint8Array([1, 2, 3]))

  const right = zipSync({ 'ppt/_rels/presentation.xml.rels': strToU8(rels(['slideMaster', 'slide'])) })

  expect(fixRelationshipOrder(right)).toBe(right)
})
