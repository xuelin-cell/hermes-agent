import { strFromU8, strToU8, unzipSync, zipSync, zlibSync } from 'fflate'

/** 生成左红右蓝的 4×2 PNG，原生检查可用实际像素核对裁剪和翻转。 */
function picture() {
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
  const header = new Uint8Array(13)
  new DataView(header.buffer).setUint32(0, 4)
  new DataView(header.buffer).setUint32(4, 2)
  header[8] = 8
  header[9] = 2
  const row = [0, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]

  /** PNG 块记录标准 CRC32，不依赖本机图像软件或新增库。 */
  function chunk(kind: string, data: Uint8Array) {
    const bytes = new Uint8Array(12 + data.length)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, data.length)
    bytes.set(strToU8(kind), 4)
    bytes.set(data, 8)
    let crc = 0xffffffff

    for (const byte of bytes.subarray(4, -4)) {
      crc ^= byte

      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
      }
    }

    view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0)

    return bytes
  }

  const parts = [
    signature,
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(Uint8Array.from([...row, ...row]))),
    chunk('IEND', new Uint8Array())
  ]

  return Uint8Array.from(parts.flatMap(bytes => [...bytes]))
}

/** 在真实工作簿中加入三种锚点，图片和绘图均通过正式关系定位。 */
export function createImageWorkbook(base: Uint8Array) {
  const parts = unzipSync(base)
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  parts['xl/worksheets/named.xml'] = strToU8(
    strFromU8(parts['xl/worksheets/named.xml']).replace('</worksheet>', '<drawing r:id="picture-link"/></worksheet>')
  )
  parts['xl/worksheets/_rels/named.xml.rels'] = strToU8(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="picture-link" Type="${ns}/drawing" Target="../drawings/pictures.xml"/></Relationships>`
  )
  parts['xl/drawings/_rels/pictures.xml.rels'] = strToU8(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="bitmap" Type="${ns}/image" Target="../media/colors.png"/></Relationships>`
  )
  parts['xl/media/colors.png'] = picture()

  /** 只生成绘图图片节点，不调用 Office 或修改用户文件。 */
  function pic(crop = '', transform = '') {
    return `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="内嵌图片"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="bitmap"/>${crop}<a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm ${transform}/><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`
  }

  /** 单元格偏移按 EMU 写入，可直接核对像素位置。 */
  function marker(name: string, row: number, column: number, x = 0, y = 0) {
    return `<xdr:${name}><xdr:col>${column}</xdr:col><xdr:colOff>${x * 9525}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${y * 9525}</xdr:rowOff></xdr:${name}>`
  }

  parts['xl/drawings/pictures.xml'] =
    strToU8(`<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${ns}">
    <xdr:oneCellAnchor>${marker('from', 1, 3, 6, 5)}<xdr:ext cx="914400" cy="609600"/>${pic('<a:srcRect l="50000"/>')}<xdr:clientData/></xdr:oneCellAnchor>
    <xdr:twoCellAnchor>${marker('from', 6, 3, 2, 3)}${marker('to', 9, 5, 4, 7)}${pic()}<xdr:clientData/></xdr:twoCellAnchor>
    <xdr:absoluteAnchor><xdr:pos x="4953000" y="2286000"/><xdr:ext cx="914400" cy="609600"/>${pic('', 'flipH="1" rot="0"')}<xdr:clientData/></xdr:absoluteAnchor>
  </xdr:wsDr>`)
  parts['[Content_Types].xml'] = strToU8(
    strFromU8(parts['[Content_Types].xml']).replace(
      '</Types>',
      '<Default Extension="png" ContentType="image/png"/><Override PartName="/xl/drawings/pictures.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'
    )
  )

  return zipSync(parts)
}
