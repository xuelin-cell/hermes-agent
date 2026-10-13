export interface DelimitedTable {
  headers: string[]
  limited: boolean
  rows: string[][]
}

const DELIMITERS = new Map([['csv', ','], ['tsv', '\t']])

/** 分隔符只由文件扩展名确定，不用内容猜测改变列含义。 */
export function delimiterForPath(path: string): string {
  const extension = path.split(/[?#]/, 1)[0].split('.').at(-1)?.toLowerCase() || ''

  return DELIMITERS.get(extension) || ','
}

/** 解析引号、转义引号和单元格换行；截断读取时丢弃末尾不完整记录。 */
export function parseDelimited(text: string, delimiter: string, maxRows = 500, truncated = false): DelimitedTable {
  const records: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false
  let closedQuote = false
  let limited = false
  const input = text.replace(/^\uFEFF/, '')

  /** 提交当前字段，保留空单元格和字段内空白。 */
  function endField() {
    row.push(value)
    value = ''
    closedQuote = false
  }

  /** 多读一条完整记录确认行数超限，不为结尾换行生成额外空行。 */
  function endRow() {
    endField()
    records.push(row)
    row = []
    limited = records.length > maxRows + 1
  }

  for (let index = 0; index < input.length && !limited; index += 1) {
    const character = input[index]

    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          value += '"'
          index += 1
        } else {
          quoted = false
          closedQuote = true
        }
      } else {
        value += character
      }

      continue
    }

    if (character === delimiter) {
      endField()
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && input[index + 1] === '\n') {
        index += 1
      }

      endRow()
    } else if (character === '"' && !value && !closedQuote) {
      quoted = true
    } else {
      if (character === '"' || closedQuote) {
        throw new Error('Invalid delimited field')
      }

      value += character
    }
  }

  if (quoted && !truncated) {
    throw new Error('Unclosed delimited field')
  }

  if (!limited && !truncated && (value || row.length || closedQuote)) {
    endRow()
  }

  return { headers: records[0] || [], limited, rows: records.slice(1, maxRows + 1) }
}
