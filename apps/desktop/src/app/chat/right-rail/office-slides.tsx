import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'
import { browserShellCopy, isSlideDeck, type OfficeSlideDeck, officeSlideDeck } from '@/lib/browser-shell'
import { ChevronLeft, ChevronRight, Maximize, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { PreviewTarget } from '@/store/preview'

import { PreviewEmptyState } from './preview-file'

// Browser build only (lib/browser-shell.ts::previewsOfficeAsPages): the page
// viewer for PowerPoint / Impress decks and Word / Writer documents. The
// instance converts the file with LibreOffice and renders each page as an image
// on request (deploy/hermes-mt/seed/mtuser.py). In the pane the pages scroll top
// to bottom, each image fetched once it comes within a screen of view; a deck
// can also be presented full screen, one slide at a time. Upstream would hand
// the bytes to the PDF viewer.

const STEP_KEYS: Record<string, number> = {
  ' ': 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -1,
  PageDown: 1,
  PageUp: -1
}

// Slide images are fetched from one screen above to one screen below what the list shows.
const FETCH_MARGIN = '100% 0px'
// The list's padding: a slide scrolled to keeps this much room above it.
const LIST_PADDING_PX = 16

interface Span {
  bottom: number
  top: number
}

/** The slide the counter shows: the one filling most of what the list shows
 * (the first of equals), or the last one once the list is scrolled to its end. */
export function currentSlide(slides: readonly Span[], view: Span, atEnd: boolean): number {
  if (atEnd) {
    return Math.max(slides.length, 1)
  }

  let current = 1
  let most = 0

  slides.forEach((slide, index) => {
    const shown = Math.min(slide.bottom, view.bottom) - Math.max(slide.top, view.top)

    if (shown > most + 0.5) {
      current = index + 1
      most = shown
    }
  })

  return current
}

function RoundButton({
  children,
  className,
  disabled,
  label,
  onClick
}: {
  children: ReactNode
  className?: string
  disabled?: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        'grid size-6 place-items-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-30',
        className
      )}
      disabled={disabled}
      onClick={(event: MouseEvent) => {
        event.stopPropagation()
        onClick()
      }}
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

export function OfficeSlides({ reloadKey, target }: { reloadKey: number; target: PreviewTarget }) {
  const { locale, t } = useI18n()
  const copy = browserShellCopy(locale)
  const path = target.path || target.source
  // A document is read, not presented: no full screen, pages as narrow as paper.
  const presentable = isSlideDeck(path)
  const pageLabel = presentable ? copy.slides.page : copy.slides.documentPage
  const [deck, setDeck] = useState<null | OfficeSlideDeck>(null)
  const [error, setError] = useState<null | string>(null)
  const [page, setPage] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [fetched, setFetched] = useState<ReadonlySet<number>>(() => new Set())
  const [resumeAt, setResumeAt] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pages = deck?.pages ?? 0

  useEffect(() => {
    let active = true

    setDeck(null)
    setError(null)
    setPage(1)
    setFetched(new Set())
    officeSlideDeck(path).then(
      next => {
        if (active) {
          setDeck(next)
        }
      },
      (failure: unknown) => {
        if (active) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }
    )

    return () => {
      active = false
    }
  }, [path, reloadKey])

  // Leaving full screen, the list picks up at the slide the presentation stopped on.
  useEffect(() => {
    const sync = () => {
      const on = Boolean(rootRef.current) && window.document.fullscreenElement === rootRef.current

      setFullscreen(on)

      if (fullscreen && !on) {
        setResumeAt(page)
      }
    }

    window.document.addEventListener('fullscreenchange', sync)

    return () => window.document.removeEventListener('fullscreenchange', sync)
  }, [fullscreen, page])

  useEffect(() => {
    const list = listRef.current

    if (!list || fullscreen || !resumeAt) {
      return
    }

    const slide = list.querySelector<HTMLElement>(`[data-slide="${resumeAt}"]`)

    if (slide) {
      list.scrollTop += slide.getBoundingClientRect().top - list.getBoundingClientRect().top - LIST_PADDING_PX
    }

    setResumeAt(0)
  }, [fullscreen, resumeAt])

  // The list fetches the slides near what it shows and keeps what it fetched.
  useEffect(() => {
    const list = listRef.current

    if (!list || !deck || fullscreen) {
      return
    }

    const slides = Array.from(list.querySelectorAll<HTMLElement>('[data-slide]'))

    if (typeof IntersectionObserver === 'undefined') {
      setFetched(new Set(slides.map(slide => Number(slide.dataset.slide))))

      return
    }

    const observer = new IntersectionObserver(
      entries => {
        const near = entries
          .filter(entry => entry.isIntersecting)
          .map(entry => Number((entry.target as HTMLElement).dataset.slide))

        if (near.length > 0) {
          setFetched(current => (near.every(n => current.has(n)) ? current : new Set([...current, ...near])))
        }
      },
      { root: list, rootMargin: FETCH_MARGIN }
    )

    slides.forEach(slide => observer.observe(slide))

    return () => observer.disconnect()
  }, [deck, fullscreen])

  // Presenting, the next slide is fetched ahead.
  useEffect(() => {
    if (fullscreen && deck && page < deck.pages) {
      new Image().src = deck.imageUrl(page + 1)
    }
  }, [deck, fullscreen, page])

  const go = (next: number) => setPage(Math.min(Math.max(next, 1), Math.max(pages, 1)))
  const step = (delta: number) => setPage(current => Math.min(Math.max(current + delta, 1), Math.max(pages, 1)))

  const toggleFullscreen = () => {
    if (window.document.fullscreenElement) {
      void window.document.exitFullscreen?.()
    } else {
      void rootRef.current?.requestFullscreen?.().then(() => rootRef.current?.focus())
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Home') {
      go(1)
    } else if (event.key === 'End') {
      go(pages)
    } else if (event.key in STEP_KEYS) {
      step(STEP_KEYS[event.key] ?? 0)
    } else {
      return
    }

    event.preventDefault()
  }

  const onScroll = () => {
    const list = listRef.current

    if (!list) {
      return
    }

    const slides = Array.from(list.querySelectorAll<HTMLElement>('[data-slide]'), slide => {
      const { bottom, top } = slide.getBoundingClientRect()

      return { bottom, top }
    })

    const { bottom, top } = list.getBoundingClientRect()
    const atEnd = list.scrollTop > 0 && list.scrollTop + list.clientHeight >= list.scrollHeight - 2

    setPage(currentSlide(slides, { bottom, top }, atEnd))
  }

  if (error) {
    return <PreviewEmptyState body={error} title={t.preview.unavailable} />
  }

  if (!deck) {
    return <PageLoader label={copy.slides.preparing} />
  }

  if (pages < 1) {
    return <PreviewEmptyState body={copy.officePreview.failed} title={t.preview.unavailable} />
  }

  const ratio = `${deck.width} / ${deck.height}`
  const src = deck.imageUrl
  const arrow = 'bg-white/15 text-white hover:bg-white/30'

  return (
    <div
      aria-label={target.label}
      className={cn('flex h-full w-full flex-col outline-none', fullscreen ? 'bg-black' : 'bg-muted/30')}
      onKeyDown={fullscreen ? onKeyDown : undefined}
      ref={rootRef}
      role="region"
      tabIndex={-1}
    >
      {fullscreen ? (
        <div className="group relative flex min-h-0 flex-1 items-center justify-center p-4" onClick={() => step(1)}>
          <img
            alt={copy.slides.page(page)}
            className="max-h-full max-w-full object-contain select-none"
            draggable={false}
            key={page}
            src={src(page)}
            style={{ aspectRatio: ratio }}
          />
          <RoundButton
            className={cn('absolute left-3 top-1/2 size-8 -translate-y-1/2 opacity-0 group-hover:opacity-100', arrow)}
            disabled={page <= 1}
            label={copy.slides.previous}
            onClick={() => step(-1)}
          >
            <ChevronLeft className="size-4" />
          </RoundButton>
          <RoundButton
            className={cn('absolute right-3 top-1/2 size-8 -translate-y-1/2 opacity-0 group-hover:opacity-100', arrow)}
            disabled={page >= pages}
            label={copy.slides.next}
            onClick={() => step(1)}
          >
            <ChevronRight className="size-4" />
          </RoundButton>
          <RoundButton
            className={cn('absolute right-4 top-4 size-8', arrow)}
            label={copy.slides.exitFullscreen}
            onClick={toggleFullscreen}
          >
            <X className="size-4" />
          </RoundButton>
          <span className="absolute bottom-4 right-5 text-xs font-medium text-white/70">
            {copy.slides.counter(page, pages)}
          </span>
        </div>
      ) : (
        <>
          <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-b border-border/40 px-3 text-[0.625rem] font-bold text-muted-foreground">
            <span data-slide-counter="">{copy.slides.counter(page, pages)}</span>
            {presentable && (
              <RoundButton className="hover:text-foreground" label={copy.slides.fullscreen} onClick={toggleFullscreen}>
                <Maximize className="size-3.5" />
              </RoundButton>
            )}
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto p-4 outline-none"
            onScroll={onScroll}
            ref={listRef}
            tabIndex={0}
          >
            <div className={cn('mx-auto flex flex-col gap-4', presentable ? 'max-w-5xl' : 'max-w-3xl')}>
              {Array.from({ length: pages }, (_, index) => index + 1).map(n => (
                <div
                  className="w-full shrink-0 overflow-hidden rounded-md bg-white shadow-[0_6px_24px_rgba(0,0,0,0.12)]"
                  data-slide={n}
                  key={n}
                  style={{ aspectRatio: ratio }}
                >
                  {fetched.has(n) && (
                    <img
                      alt={pageLabel(n)}
                      className="size-full object-contain select-none"
                      draggable={false}
                      src={src(n)}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
