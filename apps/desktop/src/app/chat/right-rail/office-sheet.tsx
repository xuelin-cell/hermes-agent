import DOMPurify from 'dompurify'
import { useEffect, useRef, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'
import { browserShellCopy, type OfficeSheetBook, officeSheetBook } from '@/lib/browser-shell'
import { cn } from '@/lib/utils'
import type { PreviewTarget } from '@/store/preview'

import { PreviewEmptyState } from './preview-file'

// Browser build only (lib/browser-shell.ts::previewsOfficeAsSheet): the sheet
// viewer for Excel / Calc spreadsheets. The instance has LibreOffice export the
// file as HTML (deploy/hermes-mt/seed/mtuser.py): a table per sheet, formulas
// worked out, number formats, merged cells, colours and borders kept, charts
// drawn as pictures, long sheets cut to their first rows. The tables are
// sanitized here before they are shown. Upstream would read the bytes as binary.

// What LibreOffice builds a table from. Everything else goes (scripts, frames,
// forms, event handlers); `comment` is a cell's note, shown as its tooltip.
const SHEET_TAGS = [
  'a',
  'b',
  'br',
  'col',
  'colgroup',
  'comment',
  'em',
  'font',
  'i',
  'img',
  'p',
  's',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u'
]

const SHEET_ATTRS = [
  'align',
  'bgcolor',
  'border',
  'cellpadding',
  'cellspacing',
  'color',
  'colspan',
  'face',
  'height',
  'href',
  'hspace',
  'rowspan',
  'size',
  'span',
  'src',
  'style',
  'valign',
  'vspace',
  'width'
]

// Styles that would fetch something or run something.
const ACTIVE_STYLE_RE = /url\s*\(|expression\s*\(|@import/i

// A spreadsheet looks the same in either theme: dark text on white, light
// gridlines under the cells' own borders (inline, so they win), each cell on one
// line unless the sheet breaks it.
const SHEET_CLASS = cn(
  'w-max min-w-full p-2 font-sans text-[12px] leading-[1.35] text-black',
  '[&_table]:border-collapse [&_td]:border [&_td]:border-[#e1e1e1] [&_td]:px-1.5 [&_td]:py-0.5 [&_td]:whitespace-nowrap',
  '[&_a]:text-[#0563c1] [&_a]:underline'
)

// An instance of its own: upstream sanitizes other HTML with the shared one.
let purifier: null | ReturnType<typeof DOMPurify> = null

/** One sheet's table, ready to show: sanitized, chart pictures pointed at the
 * instance (any other picture dropped), links opening in a new tab, notes as
 * tooltips. */
export function sheetFragment(html: string, imageUrl: (name: string) => null | string): DocumentFragment {
  purifier ??= DOMPurify(window)

  const fragment = purifier.sanitize(html, {
    ALLOWED_ATTR: SHEET_ATTRS,
    ALLOWED_TAGS: SHEET_TAGS,
    RETURN_DOM_FRAGMENT: true
  })

  for (const note of Array.from(fragment.querySelectorAll('comment'))) {
    const cell = note.closest('td, th')
    const text = note.textContent?.trim()

    if (cell && text) {
      cell.setAttribute('title', text)
    }

    note.remove()
  }

  for (const link of Array.from(fragment.querySelectorAll('a'))) {
    if (link.hasAttribute('href')) {
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener noreferrer')
    } else if (!link.textContent?.trim()) {
      link.remove() // the marker LibreOffice puts before a note
    }
  }

  for (const image of Array.from(fragment.querySelectorAll('img'))) {
    const url = imageUrl(image.getAttribute('src') ?? '')

    if (url) {
      image.setAttribute('src', url)
      image.setAttribute('alt', '')
      image.setAttribute('loading', 'lazy')
    } else {
      image.remove()
    }
  }

  for (const node of Array.from(fragment.querySelectorAll('[style]'))) {
    if (ACTIVE_STYLE_RE.test(node.getAttribute('style') ?? '')) {
      node.removeAttribute('style')
    }
  }

  return fragment
}

export function OfficeSheet({ reloadKey, target }: { reloadKey: number; target: PreviewTarget }) {
  const { locale, t } = useI18n()
  const copy = browserShellCopy(locale)
  const path = target.path || target.source
  const [book, setBook] = useState<null | OfficeSheetBook>(null)
  const [error, setError] = useState<null | string>(null)
  const [active, setActive] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const sheet = book?.sheets[active]

  useEffect(() => {
    let current = true

    setBook(null)
    setError(null)
    setActive(0)
    officeSheetBook(path).then(
      next => {
        if (current) {
          setBook(next)
        }
      },
      (failure: unknown) => {
        if (current) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }
    )

    return () => {
      current = false
    }
  }, [path, reloadKey])

  // The table is the sanitized fragment itself, not React's: thousands of cells
  // with LibreOffice's own attributes.
  useEffect(() => {
    const host = tableRef.current
    const scroller = scrollRef.current

    if (!host || !book || !sheet) {
      return
    }

    host.replaceChildren(sheetFragment(sheet.html, book.imageUrl))

    if (scroller) {
      scroller.scrollTop = 0
      scroller.scrollLeft = 0
    }
  }, [book, sheet])

  if (error) {
    return <PreviewEmptyState body={error} title={t.preview.unavailable} />
  }

  if (!book) {
    return <PageLoader label={copy.slides.preparing} />
  }

  if (!sheet) {
    return <PreviewEmptyState body={copy.sheet.empty} title={t.preview.unavailable} />
  }

  return (
    <div aria-label={target.label} className="flex h-full w-full flex-col bg-muted/30" role="region">
      {sheet.shown < sheet.rows && (
        <div
          className="shrink-0 border-b border-border/40 px-3 py-1.5 text-[0.6875rem] text-muted-foreground"
          data-sheet-truncated=""
        >
          {copy.sheet.truncated(sheet.shown, sheet.rows)}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-white" ref={scrollRef}>
        <div className={SHEET_CLASS} data-sheet-table="" ref={tableRef} />
      </div>
      {book.sheets.length > 1 && (
        <div
          aria-label={copy.sheet.sheets}
          className="flex h-8 shrink-0 items-stretch overflow-x-auto border-t border-border/40 px-2"
          role="tablist"
        >
          {book.sheets.map((item, index) => (
            <button
              aria-selected={index === active}
              className={cn(
                'shrink-0 whitespace-nowrap border-x border-transparent px-3 text-[0.75rem]',
                index === active
                  ? 'border-border/40 bg-white font-medium text-black'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              key={index}
              onClick={() => setActive(index)}
              role="tab"
              type="button"
            >
              {item.name || copy.sheet.unnamed(index + 1)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
