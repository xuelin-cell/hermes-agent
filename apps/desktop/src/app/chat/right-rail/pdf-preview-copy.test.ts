import { afterEach, describe, expect, it } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n/runtime'

import { pdfPreviewCopy } from './pdf-preview-copy'

afterEach(() => {
  setRuntimeI18nLocale('en')
})

describe('pdfPreviewCopy', () => {
  it('is Chinese for the zh locales and English for every other language', () => {
    expect(pdfPreviewCopy('zh').find).toBe('在文档中查找')
    expect(pdfPreviewCopy('zh-hant').find).toBe('在文档中查找')
    expect(pdfPreviewCopy('en').find).toBe('Find in document')
    expect(pdfPreviewCopy('ja').find).toBe('Find in document')
    expect(pdfPreviewCopy('en').counter(2, 5)).toBe('2 / 5')
  })

  it('follows the runtime locale when a component does not pass one', () => {
    setRuntimeI18nLocale('zh')
    expect(pdfPreviewCopy().loading).toBe('正在打开 PDF…')

    setRuntimeI18nLocale('en')
    expect(pdfPreviewCopy().loading).toBe('Opening the PDF…')
  })
})
