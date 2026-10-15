import { type Range, read, utils } from 'xlsx'

import { type PreviewStyle, readWorkbookStyles } from './styles'

export const MAX_ROWS = 500
export const MAX_GRID_CELLS = 250000

export interface PreviewCell {
  row: number
  column: number
  value: string | number | boolean
  display: string
  numberFormat?: string
  style?: PreviewStyle
}

export interface PreviewSheet {
  name: string
  rows: number
  columns: number
  cells: PreviewCell[]
  merges: Range[]
  rowHeights: number[]
  columnWidths: number[]
  hiddenRows: number[]
  hiddenColumns: number[]
  limited: boolean
}

/** 无效尺寸使用默认值，不让损坏的行高列宽污染画布几何。 */
function positive(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

/** 只解析字节与缓存值，不执行宏、公式或文档链接；行号始终保留原文件的位置。 */
export function parseWorkbook(bytes: ArrayBuffer): PreviewSheet[] {
  const styles = readWorkbookStyles(new Uint8Array(bytes))

  const book = read(new Uint8Array(bytes), {
    type: 'array',
    cellNF: true,
    cellStyles: true,
    cellHTML: false,
    cellFormula: false,
    sheetRows: MAX_ROWS
  })

  if (!book.SheetNames.length) {
    throw { code: 'unsupported' }
  }

  return book.SheetNames.map(name => {
    const source = book.Sheets[name]
    const cellStyles = styles.get(name)
    const range = utils.decode_range(source['!fullref'] || source['!ref'] || 'A1')
    const merges = source['!merges'] || []
    const originalRows = merges.reduce((end, merge) => Math.max(end, merge.e.r + 1), range.e.r + 1)
    const rows = Math.min(MAX_ROWS, originalRows)
    const columns = merges.reduce((end, merge) => Math.max(end, merge.e.c + 1), range.e.c + 1)

    if (!Number.isInteger(rows + columns) || rows < 1 || columns < 1 || columns > 16384) {
      throw { code: 'unsupported' }
    }

    if (rows * columns > MAX_GRID_CELLS) {
      throw { code: 'too_large' }
    }

    if (
      merges.some(
        ({ s, e }) =>
          ![s.r, s.c, e.r, e.c].every(value => Number.isInteger(value) && value >= 0) || e.r < s.r || e.c < s.c
      )
    ) {
      throw { code: 'unsupported' }
    }

    const cells: PreviewCell[] = []

    for (const address of new Set([...Object.keys(source), ...(cellStyles?.keys() || [])])) {
      if (!/^[A-Z]+\d+$/.test(address)) {
        continue
      }

      const { r, c } = utils.decode_cell(address)

      if (r >= rows || c >= columns) {
        continue
      }

      const cell = source[address] || { t: 'z' }
      const display = String(cell.w ?? utils.format_cell(cell))
      const raw = cell.v
      const value = cell.t !== 'e' && ['string', 'number', 'boolean'].includes(typeof raw) ? raw : display
      cells.push({ row: r, column: c, value, display, numberFormat: cell.z, style: cellStyles?.get(address) })
    }

    return {
      name,
      rows,
      columns,
      cells,
      limited: originalRows > MAX_ROWS,
      merges: merges
        .filter(merge => merge.s.r < rows && merge.s.c < columns)
        .map(merge => ({
          s: { ...merge.s },
          e: { r: Math.min(merge.e.r, rows - 1), c: Math.min(merge.e.c, columns - 1) }
        })),
      rowHeights: Array.from({ length: rows }, (_, row) => {
        const size = source['!rows']?.[row]

        // hpt 是文件中的磅数；库生成的 hpx 不一定已按 96 DPI 换算。
        return (positive(size?.hpt, (positive(size?.hpx, 20) * 72) / 96) * 96) / 72
      }),
      columnWidths: Array.from({ length: columns }, (_, column) => {
        const size = source['!cols']?.[column]

        return positive(size?.wpx, positive(size?.wch, positive(size?.width, 8.43)) * 7 + 5)
      }),
      hiddenRows: Array.from({ length: rows }, (_, row) => row).filter(row => source['!rows']?.[row]?.hidden),
      hiddenColumns: Array.from({ length: columns }, (_, column) => column).filter(
        column => source['!cols']?.[column]?.hidden
      )
    }
  })
}
