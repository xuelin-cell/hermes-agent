import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/** 在已有样式和图片样例中加入正式图表部件，不启动 Excel，也不改变原图片。 */
export function createChartWorkbook(base: Uint8Array) {
  const parts = unzipSync(base)
  const relationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

  /** 缓存以索引保存，包含中文类别和真实的空值位置。 */
  function cache(kind: string, points: string[]) {
    return `<c:${kind}><c:ptCount val="${points.length}"/>${points.map((value, index) => (value === '' ? '' : `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`)).join('')}</c:${kind}>`
  }

  /** 系列的公式仅是文档引用，测试时不会执行或连接外部数据源。 */
  function series(name: string, data: string[]) {
    return `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${name}</c:v></c:tx>
      <c:cat><c:strRef><c:f>明细!$A$2:$A$4</c:f>${cache('strCache', ['一月', '二月', '三月'])}</c:strRef></c:cat>
      <c:val><c:numRef><c:f>明细!$B$2:$B$4</c:f>${cache('numCache', data)}</c:numRef></c:val><c:smooth val="1"/></c:ser>`
  }

  const definitions = [
    {
      tag: 'barChart',
      title: '月度销售',
      data: ['10', '20', '30'],
      extra: '<c:barDir val="col"/><c:grouping val="clustered"/>',
      x: 20,
      y: 350
    },
    {
      tag: 'lineChart',
      title: '趋势变化',
      data: ['12', '', '28'],
      extra: '<c:grouping val="standard"/>',
      x: 410,
      y: 350
    },
    { tag: 'pieChart', title: '分类占比', data: ['10', '20', '30'], extra: '', x: 20, y: 630 }
  ]

  for (const [index, definition] of definitions.entries()) {
    const id = `chart-${index}`
    const target = `xl/charts/custom-${index}.xml`
    parts[target] =
      strToU8(`<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${definition.title}</a:t></a:r></a:p></c:rich></c:tx></c:title>
      <c:plotArea><c:${definition.tag}>${definition.extra}${series('销量', definition.data)}<c:dLbls><c:showVal val="1"/></c:dLbls></c:${definition.tag}>
        <c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling></c:catAx>
        <c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling></c:valAx>
      </c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`)

    const anchor = `<xdr:absoluteAnchor><xdr:pos x="${definition.x * 9525}" y="${definition.y * 9525}"/><xdr:ext cx="3429000" cy="2286000"/>
      <xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="${index + 10}" name="${definition.title}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
        <xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${id}"/></a:graphicData></a:graphic>
      </xdr:graphicFrame><xdr:clientData/></xdr:absoluteAnchor>`

    parts['xl/drawings/pictures.xml'] = strToU8(
      strFromU8(parts['xl/drawings/pictures.xml']).replace('</xdr:wsDr>', anchor + '</xdr:wsDr>')
    )
    parts['xl/drawings/_rels/pictures.xml.rels'] = strToU8(
      strFromU8(parts['xl/drawings/_rels/pictures.xml.rels']).replace(
        '</Relationships>',
        `<Relationship Id="${id}" Type="${relationship}/chart" Target="../charts/custom-${index}.xml"/></Relationships>`
      )
    )
    parts['[Content_Types].xml'] = strToU8(
      strFromU8(parts['[Content_Types].xml']).replace(
        '</Types>',
        `<Override PartName="/${target}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`
      )
    )
  }

  return zipSync(parts)
}
