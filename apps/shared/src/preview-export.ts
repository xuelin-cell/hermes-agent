import { strToU8, zipSync } from 'fflate/browser'

export interface PreviewExport {
  format: 'md' | 'pdf' | 'docx'
  name: string
  content: string
}
export type PreviewExportResult = { status: 'saved' | 'cancelled' | 'failed' | 'handed-off' }

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''

  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }

  return btoa(binary)
}

/** 沿用桌面 OOXML altChunk 封装，不依赖 Node、Electron 或本机 Office。 */
export function wordDocument(html: string): Uint8Array {
  const boundary = '----hermes-preview-' + crypto.randomUUID()
  const images: string[] = []

  const body = html.replace(
    /(<img\b[^>]*?\ssrc=)(['"])data:(image\/[\w.+-]+);base64,([^'"]+)\2/gi,
    (_match, prefix, quote, mime, data) => {
      const location = `file:///preview/image${images.length}`
      images.push(
        `--${boundary}\r\nContent-Type: ${mime}\r\nContent-Transfer-Encoding: base64\r\nContent-Location: ${location}\r\n\r\n${data}\r\n`
      )

      return `${prefix}${quote}${location}${quote}`
    }
  )

  const mht = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${boundary}"; type="text/html"\r\n\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\nContent-Location: file:///preview/document.html\r\n\r\n${base64Utf8(body).replace(/.{76}/g, '$&\r\n')}\r\n${images.join('')}--${boundary}--`
  const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

  const files = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="mht" ContentType="message/rfc822"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${relationships}"><Relationship Id="document" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${relationships}"><Relationship Id="html" Type="${office}/aFChunk" Target="afchunk.mht"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${office}"><w:body><w:altChunk r:id="html"/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
    'word/afchunk.mht': mht
  }

  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])))
}
