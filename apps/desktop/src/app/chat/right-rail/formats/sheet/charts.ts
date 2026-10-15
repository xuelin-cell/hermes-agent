import { utils, type WorkBook } from 'xlsx'

import { attr, child, children, descendants, workbookDrawings, type WorkbookPackage } from './package'

export interface PreviewChart {
  anchor: Element
  kind: 'bar' | 'line' | 'pie' | 'doughnut' | 'area' | 'scatter'
  title: string
  horizontal: boolean
  grouping?: string
  legend?: string
  labels: boolean
  series: { name: string; categories: (string | number | null)[]; values: (number | null)[]; smooth: boolean }[]
  axes: { title: string; min?: number; max?: number; inverse: boolean }[]
}

const KINDS: Record<string, PreviewChart['kind']> = {
  barChart: 'bar',
  lineChart: 'line',
  pieChart: 'pie',
  doughnutChart: 'doughnut',
  areaChart: 'area',
  scatterChart: 'scatter'
}

/** 只读纯文本标题或系列名，不把文档内容当 HTML、链接或代码。 */
function text(element: Element | undefined) {
  return (
    descendants(element, 't')
      .map(node => node.textContent || '')
      .join('') ||
    descendants(element, 'v')[0]?.textContent ||
    ''
  )
}

/** 缓存按 idx 保留空洞；缺缓存时只读本工作簿的单元格缓存值，绝不执行公式。 */
function values(element: Element | undefined, book: WorkBook): (string | number | null)[] {
  if (!element) {
    return []
  }

  const cache = ['strCache', 'numCache', 'strLit', 'numLit'].map(tag => descendants(element, tag)[0]).find(Boolean)

  if (cache && (children(cache, 'pt').length || Number(attr(child(cache, 'ptCount'), 'val')) > 0)) {
    const points = children(cache, 'pt')
    const count = Number(attr(child(cache, 'ptCount'), 'val') || 0)
    const indices = points.map(point => Number(attr(point, 'idx')))
    const length = indices.reduce((end, index) => Math.max(end, index + 1), count)

    if (
      !Number.isInteger(length) ||
      length < 0 ||
      length > 10000 ||
      points.length > 10000 ||
      indices.some(index => !Number.isInteger(index) || index < 0)
    ) {
      throw { code: 'too_large' }
    }

    const result: (string | number | null)[] = Array.from({ length }, () => null)
    points.forEach((point, index) => {
      result[indices[index]] = child(point, 'v')?.textContent ?? null
    })

    return result
  }

  const formula = descendants(element, 'f')[0]?.textContent || ''

  if (!formula) {
    return child(element, 'v') ? [child(element, 'v')!.textContent] : []
  }

  const match = /^(?:'((?:[^']|'')+)'|([^![\]]+))!\$?([A-Z]+)\$?([1-9]\d*)(?::\$?([A-Z]+)\$?([1-9]\d*))?$/.exec(formula)

  if (!match) {
    throw { code: 'unsupported' }
  }

  const sheet = book.Sheets[(match[1] || match[2]).replace(/''/g, "'")]
  const range = utils.decode_range(`${match[3]}${match[4]}:${match[5] || match[3]}${match[6] || match[4]}`)
  const size = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1)

  if (!sheet || range.e.r >= 500 || range.e.c >= 16384 || size < 1 || size > 10000) {
    throw { code: 'unsupported' }
  }

  const result: (string | number | null)[] = []

  for (let row = range.s.r; row <= range.e.r; row++) {
    for (let column = range.s.c; column <= range.e.c; column++) {
      const cell = sheet[utils.encode_cell({ r: row, c: column })]
      result.push(cell?.t === 'e' ? null : (cell?.v ?? null))
    }
  }

  return result
}

/** 图表只读取常见二维类型；不把组合、三维或坏数据静默画成另一种图。 */
export function readWorkbookCharts(archive: WorkbookPackage, book: WorkBook) {
  const result = new Map<string, PreviewChart[]>()

  let count = 0,
    total = 0

  for (const { name, anchor, relations } of workbookDrawings(archive)) {
    const reference = descendants(anchor, 'chart')[0]

    if (!reference) {
      continue
    }

    const id = Array.from(reference.attributes).find(attribute => attribute.localName === 'id')?.value
    const doc = archive.xml(relations.find(rel => rel.id === id)?.target)
    const chart = descendants(doc, 'chart')[0]
    const plots = Array.from(child(chart, 'plotArea')?.children || []).filter(node => /Chart$/.test(node.localName))

    const plot = plots[0],
      kind = plot && KINDS[plot.localName]

    if (!kind || plots.length !== 1 || ++count > 32) {
      throw { code: 'unsupported' }
    }

    const entries = children(plot, 'ser')

    if (!entries.length || entries.length > 64) {
      throw { code: 'too_large' }
    }

    const series = entries.map((ser, index) => {
      const categories = values(child(ser, kind === 'scatter' ? 'xVal' : 'cat'), book)
      const data = values(child(ser, kind === 'scatter' ? 'yVal' : 'val'), book)
      total += categories.length + data.length

      if (total > 20000) {
        throw { code: 'too_large' }
      }

      return {
        name: text(child(ser, 'tx')) || String(values(child(ser, 'tx'), book)[0] || `Series ${index + 1}`),
        categories,
        values: data.map(value =>
          value === null || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value)
        ),
        smooth: ['1', 'true'].includes(attr(child(ser, 'smooth'), 'val') || '')
      }
    })

    if (!series.length || series.length > 64 || !series.some(item => item.values.length)) {
      throw { code: 'unsupported' }
    }

    if (
      !['scatter', 'pie', 'doughnut'].includes(kind) &&
      series.some(item => JSON.stringify(item.categories) !== JSON.stringify(series[0].categories))
    ) {
      throw { code: 'unsupported' }
    }

    const axisNodes =
      kind === 'scatter' ? descendants(chart, 'valAx') : ['catAx', 'valAx'].map(tag => descendants(chart, tag)[0])

    const axes = [axisNodes[0], axisNodes[1]].map(axis => {
      const scaling = child(axis, 'scaling')

      /** 缺少轴边界保持自动，不把缺失值错误转换成零。 */
      function bound(key: string) {
        const raw = attr(child(scaling, key), 'val')

        return raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : undefined
      }

      return {
        title: text(child(axis, 'title')),
        min: bound('min'),
        max: bound('max'),
        inverse: attr(child(scaling, 'orientation'), 'val') === 'maxMin'
      }
    })

    const legend = child(chart, 'legend')
    const charts = result.get(name) || []
    charts.push({
      anchor,
      kind,
      series,
      axes,
      title: text(child(chart, 'title')),
      horizontal: attr(child(plot, 'barDir'), 'val') === 'bar',
      grouping: attr(child(plot, 'grouping'), 'val'),
      legend: legend ? attr(child(legend, 'legendPos'), 'val') || 'b' : undefined,
      labels: ['1', 'true'].includes(attr(child(child(plot, 'dLbls'), 'showVal'), 'val') || '')
    })
    result.set(name, charts)
  }

  return result
}
