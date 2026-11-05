import { getRuntimeI18nLocale } from '@/i18n/runtime'

// desktop-mt: the PDF viewer's own words (pdf-preview.tsx), kept here rather
// than in the upstream locale files, which change with nearly every upstream
// release. Chinese for the zh locales, English for every other language.

export interface PdfPreviewCopy {
  counter: (page: number, pages: number) => string
  failed: string
  find: string
  findClose: string
  findNext: string
  findNone: string
  findPrevious: string
  fitWidth: string
  invalid: string
  loading: string
  password: string
  passwordIncorrect: string
  passwordLabel: string
  passwordOpen: string
  zoomIn: string
  zoomOut: string
}

const COPY: Record<'en' | 'zh', PdfPreviewCopy> = {
  en: {
    counter: (page: number, pages: number) => `${page} / ${pages}`,
    failed: 'Could not open this PDF. Download it instead.',
    find: 'Find in document',
    findClose: 'Close search',
    findNext: 'Next match',
    findNone: 'No matches',
    findPrevious: 'Previous match',
    fitWidth: 'Fit to width',
    invalid: 'This file is damaged or is not a PDF. Download it instead.',
    loading: 'Opening the PDF…',
    password: 'This PDF is protected by a password.',
    passwordIncorrect: 'Wrong password. Try again.',
    passwordLabel: 'Password',
    passwordOpen: 'Open',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out'
  },
  zh: {
    counter: (page: number, pages: number) => `${page} / ${pages}`,
    failed: '打不开这个 PDF，请下载后查看。',
    find: '在文档中查找',
    findClose: '关闭查找',
    findNext: '下一个',
    findNone: '无结果',
    findPrevious: '上一个',
    fitWidth: '适合宽度',
    invalid: '文件已损坏或不是 PDF，请下载后查看。',
    loading: '正在打开 PDF…',
    password: '这个 PDF 设了密码。',
    passwordIncorrect: '密码不对，请重新输入。',
    passwordLabel: '密码',
    passwordOpen: '打开',
    zoomIn: '放大',
    zoomOut: '缩小'
  }
}

/** Components pass `useI18n().locale`: the runtime locale is only synced in an
 * effect, after the first render — which the React Compiler may have memoized. */
export function pdfPreviewCopy(locale: string = getRuntimeI18nLocale()): PdfPreviewCopy {
  return locale.startsWith('zh') ? COPY.zh : COPY.en
}
