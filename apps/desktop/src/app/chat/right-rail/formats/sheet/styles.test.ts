import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { expect, it } from 'vitest'
import { read } from 'xlsx'

import { createStyledWorkbook } from '../../../../../../scripts/sheet-styles.fixture'

import { toFortuneWorkbook } from './fortune'
import { parseWorkbook } from './model'
import { openWorkbookPackage } from './package'
import { readWorkbookStyles } from './styles'

/** 修改压缩包内的真实 XML，不替换正式解析器或样式结果。 */
function fixture(change?: (parts: Record<string, Uint8Array>) => void) {
  const parts = unzipSync(createStyledWorkbook())
  change?.(parts)

  return zipSync(parts).buffer as ArrayBuffer
}

it('沿关系读取改名的表，恢复中文字体、RGB、主题与索引色及四边框', () => {
  const sheets = parseWorkbook(fixture())
  const header = sheets[0].cells.find(cell => cell.row === 0 && cell.column === 0)
  expect(header).toMatchObject({
    value: '中文数据',
    style: {
      fontFamily: 'Arial',
      fontSize: 16,
      bold: true,
      italic: true,
      underline: true,
      strike: true,
      color: '#990000',
      fill: '#FFEEDD',
      horizontal: 'center',
      vertical: 'center',
      wrap: true,
      borders: {
        l: { style: 'thin', color: '#112233' },
        r: { style: 'double', color: '#008800' },
        t: { style: 'dashed', color: '#FF0000' },
        b: { style: 'thick', color: '#0000FF' }
      }
    }
  })
  // dk1 先于 lt1 出现在 XML，但电子表格颜色编号 0/1 仍然对应 lt1/dk1。
  expect(sheets[0].cells.find(cell => cell.row === 3 && cell.column === 0)?.style?.color).toBe('#112233')
  expect(sheets[0].cells.find(cell => cell.row === 2 && cell.column === 1)?.style).toMatchObject({
    color: '#FDFEFE',
    fill: '#333333'
  })
  const fortune = toFortuneWorkbook(sheets)[0]
  expect(fortune.celldata?.find(cell => cell.r === 0 && cell.c === 0)?.v).toMatchObject({
    ff: 'Arial',
    fs: 16,
    fc: '#990000',
    bg: '#FFEEDD',
    bl: 1,
    it: 1,
    un: 1,
    cl: 1,
    ht: 0,
    vt: 0,
    tb: '2'
  })
  expect(fortune.config?.borderInfo).toContainEqual({
    rangeType: 'range',
    borderType: 'border-right',
    style: 7,
    color: '#008800',
    range: [{ row: [0, 0], column: [0, 1] }]
  })
  expect(fortune.config?.borderInfo).toContainEqual({
    rangeType: 'cell',
    value: {
      row_index: 5,
      col_index: 2,
      l: { style: 1, color: '#112233' },
      r: { style: 7, color: '#008800' },
      t: { style: 4, color: '#FF0000' },
      b: { style: 13, color: '#0000FF' }
    }
  })
  expect(sheets[1].cells[0].value).toBe('第二表内容')
})

it('继承基础格式，尊重显式 apply*=0 与布尔关闭；tint 与正式 SheetJS 填充解析一致', () => {
  const bytes = fixture()
  const sheet = parseWorkbook(bytes)[0]
  const inherited = sheet.cells.find(cell => cell.row === 1 && cell.column === 0)?.style
  const explicitOff = sheet.cells.find(cell => cell.row === 2 && cell.column === 0)?.style
  expect(inherited).toEqual(explicitOff)
  expect(inherited).toMatchObject({
    fontFamily: 'Arial',
    fontSize: 12,
    horizontal: 'right',
    vertical: 'top',
    wrap: true,
    color: '#264D73'
  })

  const explicitFill = fixture(parts => {
    parts['xl/styles.xml'] = strToU8(
      strFromU8(parts['xl/styles.xml']).replace('fontId="1" fillId="2"', 'fontId="1" fillId="3"')
    )
  })

  const parsedByLibrary = read(new Uint8Array(explicitFill), { type: 'array', cellStyles: true })
  // 独立解析库给出同一主题色的 tint，避免用另一份自写算法证明自己。
  expect(inherited?.fill).toBe('#' + parsedByLibrary.Sheets['明细'].A1.s.fgColor.rgb)
  const off = toFortuneWorkbook([sheet])[0].celldata?.find(cell => cell.r === 1 && cell.c === 1)?.v
  expect(off).toMatchObject({ bl: 0, it: 0, un: 0, cl: 0, fc: '#333333' })
  expect(toFortuneWorkbook([sheet])[0].celldata?.find(cell => cell.r === 2 && cell.c === 0)?.v?.ct).toMatchObject({
    t: 'inlineStr',
    s: [{ v: '中文换行\n第二行', ff: 'Arial', tb: '2' }]
  })
})

it('有样式的空白格保留背景和边框，但不补出公式或可编辑内容', () => {
  const sheet = parseWorkbook(fixture())[0]
  expect(sheet.cells.find(cell => cell.row === 5 && cell.column === 2)).toMatchObject({
    value: '',
    display: '',
    style: { fill: '#FFEEDD' }
  })
  const blank = toFortuneWorkbook([sheet])[0].celldata?.find(cell => cell.r === 5 && cell.c === 2)?.v
  expect(blank).toMatchObject({ v: '', m: '', bg: '#FFEEDD' })
  expect(blank?.f).toBeUndefined()
  expect(sheet.cells.every(cell => cell.row < 500)).toBe(true)
})

it('自定义索引色、XML 前缀与非固定 styles/theme 路径仍按文件自身定义处理', () => {
  const bytes = fixture(parts => {
    let styles = strFromU8(parts['xl/styles.xml']).replace(
      '</styleSheet>',
      '<colors><indexedColors>' +
        Array.from({ length: 64 }, () => '<rgbColor rgb="FF123456"/>').join('') +
        '</indexedColors></colors></styleSheet>'
    )

    styles = styles.replace('xmlns=', 'xmlns:s=').replace(/<(\/?)([A-Za-z][\w]*)/g, '<$1s:$2')
    parts['xl/custom-styles.xml'] = strToU8(styles)
    parts['xl/custom-theme.xml'] = parts['xl/theme/theme1.xml']
    delete parts['xl/styles.xml']
    delete parts['xl/theme/theme1.xml']
    parts['xl/_rels/workbook.xml.rels'] = strToU8(
      strFromU8(parts['xl/_rels/workbook.xml.rels'])
        .replace('Target="styles.xml"', 'Target="custom-styles.xml"')
        .replace('Target="theme/theme1.xml"', 'Target="custom-theme.xml"')
    )
  })

  const styles = readWorkbookStyles(openWorkbookPackage(new Uint8Array(bytes))).get('明细')!
  expect(styles.get('B2')?.color).toBe('#123456')
  expect(styles.get('B3')?.fill).toBe('#123456')
  expect(styles.get('A1')?.borders?.t?.color).toBe('#123456')
  expect(styles.get('A4')?.color).toBe('#112233')
})

it('缺失颜色和无效字号不变成黑色索引或无穷字号，样式对象不向画布传 NaN', () => {
  const sheet = parseWorkbook(
    fixture(parts => {
      parts['xl/styles.xml'] = strToU8(
        strFromU8(parts['xl/styles.xml'])
          .replace('<color theme="1"/>', '<color/>')
          .replace('<sz val="11"/>', '<sz val="Infinity"/>')
      )
    })
  )[0]

  const cell = toFortuneWorkbook([sheet])[0].celldata?.find(cell => cell.r === 3 && cell.c === 0)?.v
  expect(cell?.fc).toBeUndefined()
  expect(cell?.fs).toBeUndefined()
  expect(cell).toMatchObject({ bl: 0, it: 0, un: 0, cl: 0 })
})

it('损坏 XML、DTD 和超量展开被正式失败链拒绝，不当作成功的简化表', () => {
  for (const xml of [
    '<styleSheet><font></styleSheet>',
    '<!DOCTYPE styleSheet [<!ENTITY x SYSTEM "file:///secret">]><styleSheet/>'
  ]) {
    expect(() =>
      parseWorkbook(
        fixture(parts => {
          parts['xl/styles.xml'] = strToU8(xml)
        })
      )
    ).toThrowError(expect.objectContaining({ code: 'unsupported' }))
  }

  expect(() =>
    parseWorkbook(
      fixture(parts => {
        parts['xl/oversized.xml'] = new Uint8Array(16 * 1024 * 1024)
      })
    )
  ).toThrowError(expect.objectContaining({ code: 'too_large' }))
})
