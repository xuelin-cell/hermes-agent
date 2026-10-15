import type { CellWithRowAndCol, Sheet } from '@fortune-sheet/core'

import { MAX_GRID_CELLS, type PreviewSheet } from './model'

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
            v: cell.value,
            m: cell.display,
            ct: {
              fa: cell.numberFormat || 'General',
              t: typeof cell.value === 'number' ? 'n' : typeof cell.value === 'boolean' ? 'b' : 's'
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
        merge,
        rowlen: Object.fromEntries(sheet.rowHeights.map((height, row) => [row, height])),
        columnlen: Object.fromEntries(sheet.columnWidths.map((width, column) => [column, width])),
        rowhidden: Object.fromEntries(sheet.hiddenRows.map(row => [row, 0])),
        colhidden: Object.fromEntries(sheet.hiddenColumns.map(column => [column, 0]))
      }
    }
  })
}
