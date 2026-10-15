import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'

import { createImageWorkbook } from '../../../../../../scripts/sheet-images.fixture'
import { createStyledWorkbook } from '../../../../../../scripts/sheet-styles.fixture'

import { toFortuneWorkbook } from './fortune'
import { validateWorkbookImages } from './images'
import { parseWorkbook } from './model'

/** 修改实际工作簿部件，保留正式 ZIP、XML 和表格适配链。 */
function fixture(change?: (parts: Record<string, Uint8Array>) => void) {
  const parts = unzipSync(createImageWorkbook(createStyledWorkbook()))
  change?.(parts)

  return zipSync(parts).buffer as ArrayBuffer
}

afterEach(() => vi.unstubAllGlobals())

it('三种锚点沿关系读取，EMU 换算位置与大小；隐藏行列不占位置', () => {
  const sheets = parseWorkbook(fixture())
  expect(sheets[0].images?.length).toBe(3)
  const first = sheets[0]
  first.columnWidths = [80, 90, 100, 110, 120, 130]
  first.rowHeights = Array.from({ length: 500 }, () => 24)
  first.hiddenRows = [0]
  first.hiddenColumns = [1]
  const images = toFortuneWorkbook(sheets)[0].images!
  expect(images[0]).toMatchObject({ id: 'preview-image-0-0', left: 186, top: 5, width: 96, height: 64 })
  expect(images[1]).toMatchObject({ left: 182, top: 123, width: 232, height: 76 })
  expect(images[2]).toMatchObject({ left: 520, top: 240, width: 96, height: 64 })
  expect(toFortuneWorkbook(sheets)[1].images).toEqual([])
})

it('无处理的位图直接使用；裁剪和翻转只生成含内嵌位图的安全容器', () => {
  const images = toFortuneWorkbook(parseWorkbook(fixture()))[0].images!
  expect(images[1].src).toMatch(/^data:image\/png;base64,/)
  const svg = atob(images[0].src.split(',')[1])
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  expect(doc.documentElement.getAttribute('width')).toBe('96')
  expect(doc.getElementsByTagName('image')[0].getAttribute('x')).toBe('-96')
  expect(doc.getElementsByTagName('image')[0].getAttribute('width')).toBe('192')
  expect(svg).not.toMatch(/script|foreignObject|https:|file:/)
  expect(atob(images[2].src.split(',')[1])).toContain('scale(-1 1)')
})

it('不请求外链，显式嵌入却缺失或不支持的图片返回失败而非空白成功', () => {
  const external = fixture(parts => {
    parts['xl/drawings/pictures.xml'] = strToU8(
      strFromU8(parts['xl/drawings/pictures.xml']).replaceAll('r:embed="bitmap"', 'r:link="remote"')
    )
    parts['xl/drawings/_rels/pictures.xml.rels'] = strToU8(
      '<Relationships><Relationship Id="remote" Target="https://should-not-load.invalid/a.png" TargetMode="External"/></Relationships>'
    )
  })

  expect(toFortuneWorkbook(parseWorkbook(external))[0].images).toEqual([])
  expect(() =>
    parseWorkbook(
      fixture(parts => {
        delete parts['xl/drawings/pictures.xml']
      })
    )
  ).toThrowError(expect.objectContaining({ code: 'unsupported' }))

  for (const target of [
    '../media/missing.png',
    '../media/drawing.emf',
    'https://should-not-load.invalid/a.png',
    '../../../../secret.png'
  ]) {
    expect(() =>
      parseWorkbook(
        fixture(parts => {
          parts['xl/drawings/_rels/pictures.xml.rels'] = strToU8(
            strFromU8(parts['xl/drawings/_rels/pictures.xml.rels']).replace('../media/colors.png', target)
          )
        })
      )
    ).toThrowError(expect.objectContaining({ code: 'unsupported' }))
  }
})

it('图片只从前 500 行区域开始显示；无效几何和裁剪、过量图片与媒体拒绝', () => {
  const sheets = parseWorkbook(
    fixture(parts => {
      parts['xl/drawings/pictures.xml'] = strToU8(
        strFromU8(parts['xl/drawings/pictures.xml']).replace('<xdr:row>1</xdr:row>', '<xdr:row>100000</xdr:row>')
      )
    })
  )

  expect(toFortuneWorkbook(sheets)[0].images?.length).toBe(2)
  expect(() =>
    toFortuneWorkbook(
      parseWorkbook(
        fixture(parts => {
          parts['xl/drawings/pictures.xml'] = strToU8(
            strFromU8(parts['xl/drawings/pictures.xml']).replace('cx="914400"', 'cx="0"')
          )
        })
      )
    )
  ).toThrowError(expect.objectContaining({ code: 'unsupported' }))
  expect(() =>
    parseWorkbook(
      fixture(parts => {
        parts['xl/drawings/pictures.xml'] = strToU8(
          strFromU8(parts['xl/drawings/pictures.xml']).replace('l="50000"', 'l="50000" r="50000"')
        )
      })
    )
  ).toThrowError(expect.objectContaining({ code: 'unsupported' }))
  expect(() =>
    parseWorkbook(
      fixture(parts => {
        const xml = strFromU8(parts['xl/drawings/pictures.xml'])
        parts['xl/drawings/pictures.xml'] = strToU8(
          xml.replace(
            '</xdr:wsDr>',
            xml.match(/<xdr:oneCellAnchor>[\s\S]*?<\/xdr:oneCellAnchor>/)![0].repeat(64) + '</xdr:wsDr>'
          )
        )
      })
    )
  ).toThrowError(expect.objectContaining({ code: 'too_large' }))
  expect(() =>
    parseWorkbook(
      fixture(parts => {
        parts['xl/media/oversized.png'] = new Uint8Array(32 * 1024 * 1024)
      })
    )
  ).toThrowError(expect.objectContaining({ code: 'too_large' }))
})

it('挂载前检查真实解码结果；坏位图继续报告失败', async () => {
  const decode = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      naturalWidth = 4
      naturalHeight = 2
      decode = decode
    }
  )
  const sheets = parseWorkbook(fixture())
  await expect(validateWorkbookImages(sheets)).resolves.toBeUndefined()
  expect(decode).toHaveBeenCalledTimes(3)
  decode.mockRejectedValue(new Error('controlled decoder failure'))
  await expect(validateWorkbookImages(sheets)).rejects.toEqual({ code: 'unsupported' })
})
