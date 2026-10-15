export type OfficeDocumentKind = 'word' | 'slides' | 'sheet'
export type OfficeConverter = 'ms-office' | 'wps' | 'libreoffice'
export type OfficePreviewFailureCode =
  'too_large' | 'timeout' | 'convert_failed' | 'unavailable' | 'unsupported' | 'not_found'

export const OFFICE_EXTENSIONS: Readonly<Record<OfficeDocumentKind, readonly string[]>> = {
  word: ['docx', 'doc', 'odt'],
  slides: ['pptx', 'ppt', 'odp'],
  sheet: ['xlsx', 'xls', 'ods']
}

export const OFFICE_CONVERTER_ORDER: readonly OfficeConverter[] = ['ms-office', 'wps', 'libreoffice']
export const OFFICE_SOURCE_MAX_BYTES = 100 * 1024 * 1024
export const OFFICE_PDF_MAX_BYTES = 50 * 1024 * 1024
export const OFFICE_TIMEOUT_MS = 180_000

export interface OfficePreviewSuccess {
  ok: true
  pdf: Uint8Array
  version: string
  converter: OfficeConverter
}

export interface OfficePreviewFailure {
  ok: false
  code: OfficePreviewFailureCode
}

export type OfficePreviewResult = OfficePreviewSuccess | OfficePreviewFailure

const KIND_BY_EXTENSION = new Map(
  Object.entries(OFFICE_EXTENSIONS).flatMap(([kind, extensions]) =>
    extensions.map(extension => [extension, kind as OfficeDocumentKind] as const)
  )
)

/** 取文件名最后一个点之后的扩展名（小写）。只有网址才去掉 ? 和 # 之后的部分；本机路径里它们是文件名的一部分。 */
export function fileExtension(filePath: string): string {
  const clean = /^[a-z][a-z\d+.-]*:\/\//i.test(filePath) ? filePath.split(/[?#]/, 1)[0] : filePath
  const name = clean.split(/[\\/]/).at(-1) || ''

  return name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : ''
}

/** 按文件名扩展名识别 Office 分组，未登记类型不进入转换链路。 */
export function officeDocumentKind(filePath: string): OfficeDocumentKind | null {
  return KIND_BY_EXTENSION.get(fileExtension(filePath)) || null
}
