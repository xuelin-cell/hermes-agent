import type { EChartsOption } from 'echarts'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent } from 'echarts/components'
import { init, use as registerCharts } from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { strFromU8, strToU8 } from 'fflate'

import type { PreviewChart } from './charts'
import { drawingBox } from './images'
import type { PreviewSheet } from './model'

registerCharts([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  SVGRenderer
])

/** 图表配色属于文档展示，不是应用界面主题；不复刻 Excel 的私有图表样式。 */
const COLORS = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47']

/** 从受限数据建立静态选项，禁用动画、交互及工具提示，不合并文件中的任意配置。 */
export function chartOption(chart: PreviewChart): EChartsOption {
  const percent = chart.grouping === 'percentStacked'
  const radial = chart.kind === 'pie' || chart.kind === 'doughnut'
  const names = chart.series[0].categories
  const legend = chart.legend

  const common: EChartsOption = {
    animation: false,
    backgroundColor: '#ffffff',
    color: COLORS,
    title: { text: chart.title, left: 'center', top: 6, textStyle: { fontSize: 15 } },
    textStyle: { fontFamily: 'Arial, Microsoft YaHei, sans-serif' },
    legend: {
      show: !!legend,
      orient: legend === 'l' || legend === 'r' ? 'vertical' : 'horizontal',
      left: legend === 'l' ? 4 : legend === 'r' ? undefined : 'center',
      right: legend === 'r' ? 4 : undefined,
      top: legend === 't' ? 28 : legend === 'b' ? undefined : 'middle',
      bottom: legend === 'b' ? 4 : undefined
    },
    tooltip: { show: false }
  }

  if (radial) {
    return {
      ...common,
      series: [
        {
          type: 'pie',
          silent: true,
          radius: chart.kind === 'doughnut' ? ['35%', '62%'] : '62%',
          center: ['50%', '55%'],
          label: { show: chart.labels, fontSize: 10 },
          data: chart.series[0].values.map((value, index) => ({
            name: String(names[index] ?? index + 1),
            value: value ?? NaN
          }))
        }
      ]
    }
  }

  const category = {
    type: 'category' as const,
    data: names.map((value, index) => String(value ?? index + 1)),
    name: chart.axes[0].title,
    inverse: chart.axes[0].inverse,
    axisLabel: { interval: 0, hideOverlap: false, fontSize: 10 }
  }

  const value = {
    type: 'value' as const,
    name: chart.axes[1].title,
    min: chart.axes[1].min,
    max: percent ? 100 : chart.axes[1].max,
    inverse: chart.axes[1].inverse
  }

  const series = chart.series.map(item => ({
    name: item.name,
    type: chart.kind === 'bar' ? ('bar' as const) : chart.kind === 'scatter' ? ('scatter' as const) : ('line' as const),
    silent: true,
    smooth: item.smooth,
    areaStyle: chart.kind === 'area' ? {} : undefined,
    stack: chart.grouping === 'stacked' || percent ? 'total' : undefined,
    label: { show: chart.labels, position: 'top' as const, fontSize: 10 },
    data: item.values.map((number, index) => {
      if (chart.kind === 'scatter') {
        return [item.categories[index], number]
      }

      const sum = chart.series.reduce((total, entry) => total + Math.abs(entry.values[index] || 0), 0)

      return number === null ? null : percent ? (sum ? (number / sum) * 100 : 0) : number
    })
  }))

  return {
    ...common,
    grid: {
      left: legend === 'l' ? 100 : 45,
      right: legend === 'r' ? 100 : 20,
      top: chart.title || legend === 't' ? 60 : 28,
      bottom: legend === 'b' ? 45 : 28,
      containLabel: true
    },
    xAxis:
      chart.kind === 'scatter'
        ? { type: 'value', ...chart.axes[0], name: chart.axes[0].title }
        : chart.horizontal
          ? value
          : category,
    yAxis: chart.horizontal ? category : value,
    series
  } as EChartsOption
}

/** 仅在有图表的工作簿中加载；复用图片位置和收尾，不创建常驻图表组件。 */
export function renderWorkbookCharts(sheets: PreviewSheet[]) {
  for (const sheet of sheets) {
    for (const chart of sheet.charts || []) {
      const box = drawingBox(chart.anchor, sheet)

      if (!box) {
        continue
      }

      const instance = init(null, undefined, { renderer: 'svg', ssr: true, width: box.width, height: box.height })

      try {
        instance.setOption(chartOption(chart))
        const svg = instance.renderToSVGString()
        sheet.images ||= []
        sheet.images.push({
          anchor: chart.anchor,
          src: `data:image/svg+xml;base64,${btoa(strFromU8(strToU8(svg), true))}`,
          crop: { left: 0, right: 0, top: 0, bottom: 0 },
          rotation: 0,
          flipH: false,
          flipV: false
        })
      } finally {
        instance.dispose()
      }
    }
  }
}
