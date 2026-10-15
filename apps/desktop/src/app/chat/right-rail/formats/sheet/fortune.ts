import type { Cell, CellWithRowAndCol, Sheet, SheetConfig } from '@fortune-sheet/core'

import { MAX_GRID_CELLS, type PreviewSheet } from './model'
import type { PreviewStyle } from './styles'

const BORDER_STYLES: Record<string, number> = {
  thin: 1,
  hair: 2,
  dotted: 3,
  dashed: 4,
  dashDot: 5,
  dashDotDot: 6,
  double: 7,
  medium: 8,
  mediumDashed: 9,
  mediumDashDot: 10,
  mediumDashDotDot: 11,
  slantDashDot: 12,
  thick: 13
}

/** 文档样式转成组件字段；值、数字格式和公式边界仍由原有适配负责。 */
function cellStyle(style: PreviewStyle | undefined): Partial<Cell> {
  if (!style) {
    return {}
  }

  return {
    ff: style.fontFamily,
    fs: style.fontSize,
    fc: style.color,
    bg: style.fill,
    bl: Number(!!style.bold),
    it: Number(!!style.italic),
    un: Number(!!style.underline),
    cl: Number(!!style.strike),
    ht: ({ left: 1, center: 0, centerContinuous: 0, right: 2, justify: 1, distributed: 1 } as Record<string, number>)[
      style.horizontal || ''
    ],
    vt: ({ top: 1, center: 0, bottom: 2 } as Record<string, number>)[style.vertical || ''],
    tb: style.wrap ? '2' : '1'
  }
}

/** 只读适配；不传公式与超链接，合并区域同时登记到配置与单元格。 */
export function toFortuneWorkbook(sheets: PreviewSheet[]): Sheet[] {
  let gridCells = 0
  let mergedCells = 0

  return sheets.map((sheet, index) => {
    const row = Math.max(200, sheet.rows)
    const column = Math.max(26, sheet.columns)
    gridCells += row * column

    // 画布内部仍会分配二维数组，跨工作表累计限制，不能只靠文件字节上限。
    if (gridCells > MAX_GRID_CELLS) {
      throw { code: 'too_large' }
    }

    const cells = new Map<string, CellWithRowAndCol>(
      sheet.cells.map(cell => [
        `${cell.row}_${cell.column}`,
        {
          r: cell.row,
          c: cell.column,
          v: {
            ...cellStyle(cell.style),
            v: cell.value,
            m: cell.display,
            ct: {
              fa: cell.numberFormat || 'General',
              t: typeof cell.value === 'number' ? 'n' : typeof cell.value === 'boolean' ? 'b' : 's',
              // 组件的普通字符串不会按硬换行拆行；复用其内联文本布局，不解析富文本。
              ...(cell.style?.wrap && /[\r\n]/.test(cell.display)
                ? { t: 'inlineStr', s: [{ ...cellStyle(cell.style), v: cell.display }] }
                : {})
            }
          }
        }
      ])
    )

    const merge = Object.fromEntries(
      sheet.merges.map(range => {
        const definition = { r: range.s.r, c: range.s.c, rs: range.e.r - range.s.r + 1, cs: range.e.c - range.s.c + 1 }
        mergedCells += definition.rs * definition.cs

        if (mergedCells > MAX_GRID_CELLS) {
          throw { code: 'too_large' }
        }

        for (let r = range.s.r; r <= range.e.r; r++) {
          for (let c = range.s.c; c <= range.e.c; c++) {
            const key = `${r}_${c}`
            const entry = cells.get(key) || { r, c, v: {} }
            entry.v ||= {}
            entry.v.mc = r === range.s.r && c === range.s.c ? definition : { r: range.s.r, c: range.s.c }
            cells.set(key, entry)
          }
        }

        return [`${range.s.r}_${range.s.c}`, definition]
      })
    )

    return {
      id: `preview-sheet-${index}`,
      name: sheet.name,
      order: index,
      status: index === 0 ? 1 : 0,
      row,
      column,
      addRows: 0,
      defaultRowHeight: 20,
      defaultColWidth: 64,
      celldata: [...cells.values()],
      config: {
        borderInfo: sheet.cells.flatMap<NonNullable<SheetConfig['borderInfo']>[number]>(cell => {
          const borders = Object.fromEntries(
            Object.entries(cell.style?.borders || {})
              .filter(([, side]) => BORDER_STYLES[side.style])
              .map(([key, side]) => [key, { style: BORDER_STYLES[side.style], color: side.color }])
          )

          const joined = merge[`${cell.row}_${cell.column}`]

          // 合并格的边线属于整个区域，而非仅左上角那一个物理格。
          if (joined) {
            return Object.entries(borders).map(([side, border]) => ({
              rangeType: 'range',
              borderType: `border-${({ l: 'left', r: 'right', t: 'top', b: 'bottom' } as Record<string, string>)[side]}`,
              ...border,
              range: [{ row: [joined.r, joined.r + joined.rs - 1], column: [joined.c, joined.c + joined.cs - 1] }]
            }))
          }

          return Object.keys(borders).length
            ? [{ rangeType: 'cell', value: { row_index: cell.row, col_index: cell.column, ...borders } }]
            : []
        }),
        merge,
        rowlen: Object.fromEntries(sheet.rowHeights.map((height, row) => [row, height])),
        columnlen: Object.fromEntries(sheet.columnWidths.map((width, column) => [column, width])),
        rowhidden: Object.fromEntries(sheet.hiddenRows.map(row => [row, 0])),
        colhidden: Object.fromEntries(sheet.hiddenColumns.map(column => [column, 0]))
      }
    }
  })
}
