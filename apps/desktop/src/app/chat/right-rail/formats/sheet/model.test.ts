import { expect, it } from 'vitest'
import { type BookType, utils, type WorkSheet, write } from 'xlsx'

import { toFortuneWorkbook } from './fortune'
import { MAX_ROWS, parseWorkbook } from './model'

/** 通过正式写入器生成文件字节，再交给真实解析器，不伪造解析结果。 */
function fixture(first: WorkSheet, type: BookType = 'xlsx', date1904 = false) {
  const book = utils.book_new()
  utils.book_append_sheet(book, first, '中文表')
  utils.book_append_sheet(book, utils.aoa_to_sheet([['另一张', 7]]), 'Second')
  book.Workbook = { WBProps: { date1904 } }

  return write(book, { type: 'array', bookType: type, cellStyles: true }) as ArrayBuffer
}

it.each(['xlsx', 'biff8', 'ods'] as const)('%s 真实字节可解析中文、多表与基础值', type => {
  const parsed = parseWorkbook(fixture(utils.aoa_to_sheet([['中文', 12.5, true]]), type))
  expect(parsed.map(sheet => sheet.name)).toEqual(['中文表', 'Second'])
  expect(parsed[0].cells.map(cell => cell.value)).toEqual(['中文', 12.5, true])
  expect(parsed[0]).toMatchObject({ rows: 1, columns: 3, limited: false })
  const result = toFortuneWorkbook(parsed)
  expect(result.map(sheet => sheet.id)).toEqual(['preview-sheet-0', 'preview-sheet-1'])
  expect(result.map(sheet => sheet.status)).toEqual([1, 0])
})

it('保留原坐标、日期与数字显示、缓存公式值；不把公式或链接交给组件执行', () => {
  const sheet = utils.aoa_to_sheet([])
  utils.sheet_add_aoa(
    sheet,
    [
      ['标题', null, null],
      [45292, 1234.5, true],
      [null, null, null]
    ],
    { origin: 'C3' }
  )

  sheet.C4.z = 'yyyy-mm-dd'
  sheet.D4.z = '#,##0.00'
  sheet.E4.l = { Target: 'https://should-not-open.invalid' }
  sheet.C5 = { t: 'n', v: 6, f: 'SUM(1,5)' }
  sheet.D5 = { t: 'e', v: 7 }
  sheet['!ref'] = 'C3:E5'
  sheet['!merges'] = [{ s: { r: 2, c: 2 }, e: { r: 2, c: 4 } }]
  sheet['!rows'] = [undefined!, undefined!, { hpt: 30 }, { hidden: true }]
  sheet['!cols'] = [undefined!, undefined!, { wpx: 120 }, { hidden: true }]
  const parsed = parseWorkbook(fixture(sheet))
  expect(parsed[0]).toMatchObject({ rows: 5, columns: 5, hiddenRows: [3], hiddenColumns: [3] })
  expect(parsed[0].rowHeights[2]).toBe(40)
  expect(parsed[0].columnWidths[2]).toBeCloseTo(120, 0)
  expect(parsed[0].cells.find(cell => cell.row === 3 && cell.column === 2)?.display).toBe('2024-01-01')
  expect(parsed[0].cells.find(cell => cell.row === 3 && cell.column === 3)?.display).toBe('1,234.50')
  expect(parsed[0].cells.find(cell => cell.row === 4 && cell.column === 3)?.value).toBe('#DIV/0!')
  const result = toFortuneWorkbook(parsed)[0]
  expect(result.config?.merge?.['2_2']).toEqual({ r: 2, c: 2, rs: 1, cs: 3 })
  expect(result.celldata?.find(cell => cell.r === 2 && cell.c === 4)?.v?.mc).toEqual({ r: 2, c: 2 })
  expect(result.celldata?.find(cell => cell.r === 4 && cell.c === 2)?.v).toMatchObject({ v: 6, m: '6' })
  expect(result.celldata?.every(cell => !cell.v?.f)).toBe(true)
  expect(result.hyperlink).toBeUndefined()
})

it('1904 日期系统沿用解析器产生的显示，不自行按 1900 系统重算', () => {
  const sheet = utils.aoa_to_sheet([[1]])
  sheet.A1.z = 'yyyy-mm-dd'
  const parsed = parseWorkbook(fixture(sheet, 'xlsx', true))
  expect(parsed[0].cells[0]).toMatchObject({ value: 1, display: '1904-01-02' })
})

it('空白表仍可显示；超过 500 行保留原行号并截断跨边界合并', () => {
  expect(parseWorkbook(fixture(utils.aoa_to_sheet([])))[0]).toMatchObject({ rows: 1, columns: 1, cells: [] })
  const sheet = utils.aoa_to_sheet(Array.from({ length: MAX_ROWS + 3 }, (_, row) => [row + 1]))
  sheet['!merges'] = [{ s: { r: 498, c: 0 }, e: { r: 501, c: 1 } }]
  const parsed = parseWorkbook(fixture(sheet))[0]
  expect(parsed.rows).toBe(MAX_ROWS)
  expect(parsed.limited).toBe(true)
  expect(parsed.cells.every(cell => cell.row < MAX_ROWS)).toBe(true)
  expect(parsed.merges).toEqual([{ s: { r: 498, c: 0 }, e: { r: 499, c: 1 } }])
  expect(toFortuneWorkbook([parsed])[0].config?.merge?.['498_0']).toEqual({ r: 498, c: 0, rs: 2, cs: 2 })
})

it('损坏 ZIP 失败，不把空表当作成功；二维网格累计超限时停止分配', () => {
  expect(() => parseWorkbook(Uint8Array.of(80, 75, 3, 4, 0).buffer)).toThrow()
  const oversized = utils.aoa_to_sheet([['x']])
  oversized['!ref'] = 'A1:TK500'
  expect(() => parseWorkbook(fixture(oversized))).toThrowError(expect.objectContaining({ code: 'too_large' }))
  const parsed = parseWorkbook(fixture(utils.aoa_to_sheet([['x']])))
  expect(() => toFortuneWorkbook([{ ...parsed[0], columns: 16384 }])).toThrowError(
    expect.objectContaining({ code: 'too_large' })
  )
  expect(() => toFortuneWorkbook(Array.from({ length: 50 }, () => parsed[0]))).toThrowError(
    expect.objectContaining({ code: 'too_large' })
  )
})
