import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { expect, it } from 'vitest'

import { createChartWorkbook } from '../../../../../../scripts/sheet-charts.fixture'
import { createImageWorkbook } from '../../../../../../scripts/sheet-images.fixture'
import { createStyledWorkbook } from '../../../../../../scripts/sheet-styles.fixture'

import { chartOption } from './charts-render'
import { parseWorkbook } from './model'

/** 生成真实图表工作簿，测试更改包内数据而非替换解析结果。 */
function fixture(change?: (parts: Record<string, Uint8Array>) => void) {
  const parts = unzipSync(createChartWorkbook(createImageWorkbook(createStyledWorkbook())))
  change?.(parts)

  return zipSync(parts).buffer as ArrayBuffer
}

/** 定向修改第一张图的 XML，便于检验图表语义和失败边界。 */
function edit(parts: Record<string, Uint8Array>, replace: (xml: string) => string) {
  parts['xl/charts/custom-0.xml'] = strToU8(replace(strFromU8(parts['xl/charts/custom-0.xml'])))
}

it('实际工作簿沿关系解析三种图表，保留中文标题、类别、系列、空值和轴自动范围', () => {
  const sheets = parseWorkbook(fixture())
  const charts = sheets[0].charts!
  expect(charts.map(chart => chart.kind)).toEqual(['bar', 'line', 'pie'])
  expect(charts.map(chart => chart.title)).toEqual(['月度销售', '趋势变化', '分类占比'])
  expect(charts[0].series[0]).toMatchObject({
    name: '销量',
    categories: ['一月', '二月', '三月'],
    values: [10, 20, 30]
  })
  expect(charts[1].series[0].values).toEqual([12, null, 28])
  expect(charts[0].axes[1]).toMatchObject({ min: undefined, max: undefined, inverse: false })
  expect(sheets[0].images?.length).toBe(3)
  expect(sheets[1].charts).toBeUndefined()
})

it('没有图表缓存时只读取当前工作簿单元格，不把缺失单元格挤走或执行公式', () => {
  const charts = parseWorkbook(
    fixture(parts => edit(parts, xml => xml.replace(/<c:numCache>[\s\S]*?<\/c:numCache>/, '')))
  )[0].charts!

  expect(charts[0].series[0].values).toEqual([1.25, null, 3.25])
  expect(
    parseWorkbook(
      fixture(parts =>
        edit(parts, xml =>
          xml.replace(/<c:numCache>[\s\S]*?<\/c:numCache>/, '<c:numCache><c:ptCount val="0"/></c:numCache>')
        )
      )
    )[0].charts![0].series[0].values
  ).toEqual([1.25, null, 3.25])

  for (const formula of ['SUM(1,2)', '[remote.xlsx]明细!$A$1:$A$3', '明细!$A$1:$A$100000']) {
    expect(() =>
      parseWorkbook(
        fixture(parts =>
          edit(parts, xml => xml.replace(/<c:numCache>[\s\S]*?<\/c:numCache>/, '').replace('明细!$B$2:$B$4', formula))
        )
      )
    ).toThrowError(expect.objectContaining({ code: 'unsupported' }))
  }
})

it('静态选项保留横向、堆积、百分比和反向轴，不把百分比堆积当普通总数', () => {
  const chart = parseWorkbook(fixture())[0].charts![0]
  chart.horizontal = true
  chart.grouping = 'percentStacked'
  chart.axes[0].inverse = true
  chart.series.push({ ...chart.series[0], name: '第二系列', values: [30, 20, 10] })
  const option = chartOption(chart)
  expect(option.animation).toBe(false)
  expect(option.xAxis).toMatchObject({ type: 'value', max: 100 })
  expect(option.yAxis).toMatchObject({ type: 'category', inverse: true })
  expect(option.series).toMatchObject([
    { data: [25, 50, 75], stack: 'total', silent: true },
    { data: [75, 50, 25], stack: 'total' }
  ])
  chart.grouping = 'stacked'
  expect(chartOption(chart).series).toMatchObject([{ data: [10, 20, 30] }, { data: [30, 20, 10] }])
})

it('环形、面积和散点按各自数据语义建立选项，标题内容不成为跳转', () => {
  const chart = parseWorkbook(fixture())[0].charts![0]
  chart.kind = 'doughnut'
  chart.title = '<script>alert(1)</script>'
  expect(chartOption(chart).series).toMatchObject([
    {
      type: 'pie',
      radius: ['35%', '62%'],
      data: [
        { name: '一月', value: 10 },
        { name: '二月', value: 20 },
        { name: '三月', value: 30 }
      ]
    }
  ])
  expect(chartOption(chart).title).toMatchObject({ text: chart.title })
  chart.kind = 'area'
  expect(chartOption(chart).series).toMatchObject([{ type: 'line', areaStyle: {}, smooth: true }])
  chart.kind = 'scatter'
  chart.series[0].categories = [1, 4, 9]
  expect(chartOption(chart).series).toMatchObject([
    {
      type: 'scatter',
      data: [
        [1, 10],
        [4, 20],
        [9, 30]
      ]
    }
  ])
  expect(chartOption(chart).xAxis).toMatchObject({ type: 'value' })
})

it('坏图表、外部关系、组合或未知类型走失败，不静默跳过；数据点限制在分配前生效', () => {
  for (const transform of [
    (xml: string) => xml.replaceAll('barChart', 'bar3DChart'),
    (xml: string) => xml.replace('</c:plotArea>', '<c:lineChart/></c:plotArea>'),
    (xml: string) => xml.replace('<c:ptCount val="3"/>', '<c:ptCount val="100000000"/>'),
    () => '<c:chartSpace>'
  ]) {
    expect(() => parseWorkbook(fixture(parts => edit(parts, transform)))).toThrow()
  }

  expect(() =>
    parseWorkbook(
      fixture(parts => {
        parts['xl/drawings/_rels/pictures.xml.rels'] = strToU8(
          strFromU8(parts['xl/drawings/_rels/pictures.xml.rels']).replace(
            '../charts/custom-0.xml',
            'https://external.invalid/chart.xml'
          )
        )
      })
    )
  ).toThrowError(expect.objectContaining({ code: 'unsupported' }))
})
