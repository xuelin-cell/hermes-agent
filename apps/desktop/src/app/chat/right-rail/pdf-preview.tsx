import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { browserShellCopy, pdfDocumentSource } from '@/lib/browser-shell'
import { ChevronDown, Search, X, ZoomIn, ZoomOut } from '@/lib/icons'
import type { PreviewTarget } from '@/store/preview'

import { currentSlide, RoundButton } from './office-slides'
import type { PdfEngine, PdfFindResult } from './pdf-engine'
import { MAX_ZOOM, MIN_ZOOM } from './pdf-zoom'
import { PreviewEmptyState } from './preview-file'

// Shared PDF viewer. pdf.js draws the pages in the page itself (pdf-engine.ts, loaded the
// first time a PDF is opened), laid out like the page viewer shows a Word
// document (office-slides.tsx): pages top to bottom under a page counter. The
// text can be selected and copied, and searched from the search box (⌘F / Ctrl+F
// opens it); the zoom fits the pane until it is changed.

type Status = 'error' | 'loading' | 'password' | 'ready'

/** What to say when pdf.js could not open the file. */
function failureMessage(failure: unknown, copy: ReturnType<typeof browserShellCopy>): string {
  const { name, status } = (failure ?? {}) as { name?: unknown; status?: unknown }

  if (name === 'InvalidPDFException') {
    return copy.pdf.invalid
  }

  if (name === 'ResponseException' && status === 404) {
    return copy.fileErrors.not_found
  }

  return copy.pdf.failed
}

/** 桌面直接传入字节；不提供字节时仍沿用浏览器原有的鉴权来源。 */
export function PdfPreview({
  bytes,
  reloadKey,
  target
}: {
  bytes?: Uint8Array
  reloadKey: number
  target: PreviewTarget
}) {
  const { locale, t } = useI18n()
  const copy = browserShellCopy(locale)
  const path = target.path || target.source
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const engineRef = useRef<null | PdfEngine>(null)
  const retryRef = useRef<null | ((password: string) => void)>(null)
  const composingRef = useRef(false)
  const [status, setStatus] = useState<Status>('loading')
  const [failure, setFailure] = useState<unknown>(null)
  const [pages, setPages] = useState(0)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(0)
  const [password, setPassword] = useState('')
  const [passwordWrong, setPasswordWrong] = useState(false)
  const [finding, setFinding] = useState(false)
  const [findFocus, setFindFocus] = useState(0)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<null | PdfFindResult>(null)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    const container = containerRef.current
    const viewer = viewerRef.current

    if (!container || !viewer) {
      return
    }

    let active = true
    let engine: null | PdfEngine = null

    const fail = (reason: unknown) => {
      if (active) {
        setFailure(reason)
        setStatus('error')
      }
    }

    setStatus('loading')
    setFailure(null)
    setPages(0)
    setPage(1)
    setScale(0)
    setFinding(false)
    setQuery('')
    setFound(null)

    Promise.all([import('./pdf-engine'), bytes ? { data: bytes.slice() } : pdfDocumentSource(path)]).then(
      ([{ createPdfEngine }, source]) => {
        if (!active) {
          return
        }

        engine = createPdfEngine(container, viewer, source, {
          onError: fail,
          onFind: result => active && setFound(result),
          onPages: count => {
            if (active) {
              setPages(count)
              setStatus('ready')
            }
          },
          onPassword: (retry, incorrect) => {
            if (active) {
              retryRef.current = retry
              setPassword('')
              setPasswordWrong(incorrect)
              setStatus('password')
            }
          },
          onScale: next => active && setScale(next)
        })
        engineRef.current = engine
      },
      fail
    )

    return () => {
      active = false
      engine?.destroy()
      engineRef.current = null
      retryRef.current = null
      // pdf.js draws into this element itself; the next file starts on an empty one.
      viewer.replaceChildren()
    }
  }, [bytes, path, reloadKey])

  useEffect(() => {
    if (status === 'password') {
      passwordInputRef.current?.focus()
    }
  }, [status])

  useEffect(() => {
    if (findFocus) {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    }
  }, [findFocus])

  const openFind = () => {
    setFinding(true)
    setFindFocus(n => n + 1)
  }

  const closeFind = () => {
    engineRef.current?.endFind()
    setFinding(false)
    setQuery('')
    setFound(null)
    containerRef.current?.focus({ preventScroll: true })
  }

  const step = (previous: boolean) => {
    if (query) {
      engineRef.current?.find(query, { again: true, previous })
    }
  }

  const submitPassword = () => {
    const retry = retryRef.current

    if (retry && password) {
      retryRef.current = null
      setStatus('loading')
      retry(password)
    }
  }

  // The app's ⌘F opens its find bar over the chat unless the PDF viewer has
  // focus (lib/browser-shell.ts::findInPageTakenByViewer); here it opens the
  // viewer's search.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      openFind()
    }
  }

  const onScroll = () => {
    const container = containerRef.current

    if (!container || !pages) {
      return
    }

    const spans = Array.from(viewerRef.current?.querySelectorAll<HTMLElement>('.page') ?? [], element => {
      const { bottom, top } = element.getBoundingClientRect()

      return { bottom, top }
    })

    const { bottom, top } = container.getBoundingClientRect()
    const atEnd = container.scrollTop > 0 && container.scrollTop + container.clientHeight >= container.scrollHeight - 2

    setPage(currentSlide(spans, { bottom, top }, atEnd))
  }

  const ready = status === 'ready'

  const matches = !query
    ? ''
    : found?.total
      ? copy.slides.counter(found.current, found.total)
      : found?.status === 'none'
        ? copy.pdf.findNone
        : ''

  return (
    <div
      aria-label={target.label}
      className="flex h-full w-full flex-col bg-muted/30"
      data-pdf-viewer=""
      onKeyDown={onKeyDown}
      role="region"
    >
      <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-b border-border/40 px-3 text-[0.625rem] font-bold text-muted-foreground">
        <span data-pdf-counter="">{ready ? copy.slides.counter(page, pages) : ''}</span>
        <div className="flex items-center gap-1">
          <RoundButton className="hover:text-foreground" disabled={!ready} label={copy.pdf.find} onClick={openFind}>
            <Search className="size-3.5" />
          </RoundButton>
          <RoundButton
            className="hover:text-foreground"
            disabled={!ready || scale <= MIN_ZOOM}
            label={copy.pdf.zoomOut}
            onClick={() => engineRef.current?.zoom(-1)}
          >
            <ZoomOut className="size-3.5" />
          </RoundButton>
          <Tip label={copy.pdf.fitWidth}>
            <button
              className="min-w-9 rounded-sm text-center tabular-nums transition-colors hover:text-foreground disabled:opacity-30"
              data-pdf-zoom=""
              disabled={!ready}
              onClick={() => engineRef.current?.fitWidth()}
              type="button"
            >
              {ready && scale ? `${Math.round(scale * 100)}%` : ''}
            </button>
          </Tip>
          <RoundButton
            className="hover:text-foreground"
            disabled={!ready || scale >= MAX_ZOOM}
            label={copy.pdf.zoomIn}
            onClick={() => engineRef.current?.zoom(1)}
          >
            <ZoomIn className="size-3.5" />
          </RoundButton>
        </div>
      </div>
      {finding && (
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/40 px-3 text-muted-foreground">
          <Search className="size-3.5 shrink-0" />
          <input
            aria-label={copy.pdf.find}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
            onChange={event => {
              setQuery(event.target.value)

              // While an input method is composing, the text is not what is being searched for yet.
              if (!composingRef.current) {
                engineRef.current?.find(event.target.value)
              }
            }}
            onCompositionEnd={event => {
              composingRef.current = false
              engineRef.current?.find(event.currentTarget.value)
            }}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) {
                return
              }

              if (event.key === 'Enter') {
                event.preventDefault()
                step(event.shiftKey)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                closeFind()
              }
            }}
            placeholder={copy.pdf.find}
            ref={findInputRef}
            value={query}
          />
          <span className="shrink-0 text-[0.625rem] font-bold tabular-nums" data-pdf-matches="">
            {matches}
          </span>
          <RoundButton
            className="hover:text-foreground"
            disabled={!found?.total}
            label={copy.pdf.findPrevious}
            onClick={() => step(true)}
          >
            <ChevronDown className="size-3.5 rotate-180" />
          </RoundButton>
          <RoundButton
            className="hover:text-foreground"
            disabled={!found?.total}
            label={copy.pdf.findNext}
            onClick={() => step(false)}
          >
            <ChevronDown className="size-3.5" />
          </RoundButton>
          <RoundButton className="hover:text-foreground" label={copy.pdf.findClose} onClick={closeFind}>
            <X className="size-3.5" />
          </RoundButton>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div
          className="hermes-pdf absolute inset-0 overflow-auto outline-none"
          onScroll={onScroll}
          ref={containerRef}
          tabIndex={0}
        >
          <div className="pdfViewer" ref={viewerRef} />
        </div>
        {status === 'loading' && <PageLoader className="absolute inset-0" label={copy.pdf.loading} />}
      </div>
      {status === 'error' && <PreviewEmptyState body={failureMessage(failure, copy)} title={t.preview.unavailable} />}
      {status === 'password' && (
        <PreviewEmptyState
          body={
            <form
              className="grid justify-items-center gap-2"
              onSubmit={event => {
                event.preventDefault()
                submitPassword()
              }}
            >
              <input
                aria-label={copy.pdf.passwordLabel}
                autoComplete="off"
                className="w-56 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary"
                onChange={event => setPassword(event.target.value)}
                placeholder={copy.pdf.passwordLabel}
                ref={passwordInputRef}
                type="password"
                value={password}
              />
              {passwordWrong && <span className="text-destructive">{copy.pdf.passwordIncorrect}</span>}
            </form>
          }
          primaryAction={{ disabled: !password, label: copy.pdf.passwordOpen, onClick: submitPassword }}
          title={copy.pdf.password}
        />
      )}
    </div>
  )
}
