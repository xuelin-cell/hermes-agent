export type PreviewFailureCode = 'not_found' | 'unavailable' | 'unsupported'

export interface PreviewFailure {
  code: PreviewFailureCode
}

const FAILURE_CODES = new Set<PreviewFailureCode>(['not_found', 'unavailable', 'unsupported'])

/** 保留明确的失败代码，未知异常不把内部详情显示给页面。 */
export function previewFailure(error: unknown): PreviewFailure {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined

  return { code: FAILURE_CODES.has(code as PreviewFailureCode) ? (code as PreviewFailureCode) : 'unavailable' }
}
