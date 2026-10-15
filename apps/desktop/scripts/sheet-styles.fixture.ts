import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { utils, write } from 'xlsx'

/** 生成真实 XLSX 并补入社区写入器不支持的样式，供组件和原生画布共同验收。 */
export function createStyledWorkbook(): Uint8Array {
  const book = utils.book_new()
  const sheet = utils.aoa_to_sheet(Array.from({ length: 503 }, (_, row) => [row || '中文数据', row + 0.25]))
  sheet.A2 = { t: 's', v: '继承样式' }
  sheet.A3 = { t: 's', v: '中文换行\n第二行' }
  sheet.B3 = { t: 's', v: '浅色文字' }
  sheet['!ref'] = 'A1:C503'
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]
  sheet['!cols'] = [{ wpx: 160 }, { wpx: 130 }, { wpx: 100 }]
  sheet['!rows'] = [{ hpt: 30 }, { hpt: 26 }, { hpt: 38 }]
  utils.book_append_sheet(book, sheet, '明细')
  utils.book_append_sheet(book, utils.aoa_to_sheet([['第二表内容', 7]]), '汇总')
  const parts = unzipSync(new Uint8Array(write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer))
  parts['xl/styles.xml'] = strToU8(`<?xml version="1.0"?>
    <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <fonts count="5">
        <font><name val="Arial"/><sz val="11"/><color theme="1"/></font>
        <font><name val="Arial"/><sz val="16"/><b/><i/><u/><strike/><color rgb="FF990000"/></font>
        <font><scheme val="major"/><sz val="12"/><color theme="4" tint="-0.25"/></font>
        <font><name val="Arial"/><b val="0"/><i val="false"/><u val="none"/><strike val="0"/><color indexed="63"/></font>
        <font><name val="Arial"/><color theme="0"/></font>
      </fonts>
      <fills count="5">
        <fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
        <fill><patternFill patternType="solid"><fgColor rgb="FFFFEEDD"/></patternFill></fill>
        <fill><patternFill patternType="solid"><fgColor theme="4" tint="0.4"/></patternFill></fill>
        <fill><patternFill patternType="solid"><fgColor indexed="63"/></patternFill></fill>
      </fills>
      <borders count="2"><border/>
        <border><left style="thin"><color theme="1"/></left><right style="double"><color rgb="FF008800"/></right>
          <top style="dashed"><color indexed="10"/></top><bottom style="thick"><color rgb="FF0000FF"/></bottom></border>
      </borders>
      <cellStyleXfs count="2"><xf fontId="0" fillId="0" borderId="0"/>
        <xf fontId="2" fillId="3" borderId="1"><alignment horizontal="right" vertical="top" wrapText="1"/></xf>
      </cellStyleXfs>
      <cellXfs count="6">
        <xf fontId="0" fillId="0" borderId="0" xfId="0"/>
        <xf fontId="1" fillId="2" borderId="1" xfId="0"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
        <xf xfId="1"/>
        <xf fontId="3" fillId="0" borderId="0" xfId="0"/>
        <xf fontId="0" fillId="0" borderId="0" xfId="1" applyFont="0" applyFill="false" applyBorder="0" applyAlignment="0"/>
        <xf fontId="4" fillId="4" borderId="0" xfId="0"/>
      </cellXfs>
      <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
    </styleSheet>`)
  parts['xl/theme/theme1.xml'] = strToU8(`<?xml version="1.0"?>
    <a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="夹具主题"><a:themeElements>
      <a:clrScheme name="夹具">
        <a:dk1><a:sysClr val="windowText" lastClr="112233"/></a:dk1><a:lt1><a:srgbClr val="FDFEFE"/></a:lt1>
        <a:dk2><a:srgbClr val="001122"/></a:dk2><a:lt2><a:srgbClr val="FFEEDD"/></a:lt2>
        <a:accent1><a:srgbClr val="336699"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2>
        <a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4>
        <a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6>
        <a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink>
      </a:clrScheme>
      <a:fontScheme name="夹具字体"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>
        <a:font script="Hans" typeface="Microsoft YaHei"/></a:majorFont>
        <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
      ${strFromU8(parts['xl/theme/theme1.xml']).match(/<a:fmtScheme\b[^>]*>[\s\S]*?<\/a:fmtScheme>/)![0]}
    </a:themeElements></a:theme>`)
  let xml = strFromU8(parts['xl/worksheets/sheet1.xml'])

  for (const [address, index] of Object.entries({ A1: 1, A2: 2, B2: 3, A3: 4, B3: 5 })) {
    xml = xml.replace(new RegExp(`<c r="${address}"`), `<c s="${index}" r="${address}"`)
  }

  xml = xml.replace('<row r="6">', '<row r="6"><c r="C6" s="1"/>')
  // 工作表名不等于压缩包编号；解析器必须沿正式关系找到改名后的部件。
  parts['xl/worksheets/named.xml'] = strToU8(xml)
  delete parts['xl/worksheets/sheet1.xml']

  for (const name of ['xl/_rels/workbook.xml.rels', '[Content_Types].xml']) {
    parts[name] = strToU8(strFromU8(parts[name]).replaceAll('sheet1.xml', 'named.xml'))
  }

  return zipSync(parts)
}
