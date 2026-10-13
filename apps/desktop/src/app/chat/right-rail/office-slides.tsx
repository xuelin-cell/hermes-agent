import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'
import { browserShellCopy, type OfficeSlideDeck, officeSlideDeck } from '@/lib/browser-shell'
import { ChevronLeft, ChevronRight, Maximize, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { PreviewTarget } from '@/store/preview'

import { PreviewEmptyState } from './preview-file'

// Browser build only (lib/browser-shell.ts::previewsOfficeAsSlides): the slide
// viewer for PowerPoint / Impress decks. The instance converts the deck with
// LibreOffice and renders each page as an image on request (deploy/hermes-mt/
// seed/mtuser.py); this shows one slide at a time with a thumbnail strip, arrow
// keys and full screen, where upstream would hand the bytes to the PDF viewer.

const STEP_KEYS: Record<string, number> = {
  ' ': 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -1,
  PageDown: 1,
  PageUp: -1
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
  const [deck, setDeck] = useState<null | OfficeSlideDeck>(null)
  const [error, setError] = useState<null | string>(null)
  const [page, setPage] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const pages = deck?.pages ?? 0

  useEffect(() => {
    let active = true

    setDeck(null)
    setError(null)
    setPage(1)
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

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(rootRef.current) && window.document.fullscreenElement === rootRef.current)

    window.document.addEventListener('fullscreenchange', sync)

    return () => window.document.removeEventListener('fullscreenchange', sync)
  }, [])

  // Keep the current slide's thumbnail in view, and fetch the next slide early.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-slide="${page}"]`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })

    if (deck && page < deck.pages) {
      new Image().src = deck.imageUrl(page + 1)
    }
  }, [deck, page])

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

  const arrow = fullscreen
    ? 'bg-white/15 text-white hover:bg-white/30'
    : 'bg-background/90 text-foreground shadow-sm hover:bg-background'

  return (
    <div
      aria-label={target.label}
      className={cn('flex h-full w-full flex-col outline-none', fullscreen ? 'bg-black' : 'bg-muted/30')}
      onKeyDown={onKeyDown}
      ref={rootRef}
      role="region"
      tabIndex={0}
    >
      {!fullscreen && (
        <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-b border-border/40 px-3 text-[0.625rem] font-bold text-muted-foreground">
          <span data-slide-counter="">{copy.slides.counter(page, pages)}</span>
          <RoundButton className="hover:text-foreground" label={copy.slides.fullscreen} onClick={toggleFullscreen}>
            <Maximize className="size-3.5" />
          </RoundButton>
        </div>
      )}
      <div
        className="group relative flex min-h-0 flex-1 items-center justify-center p-4"
        onClick={() => (fullscreen ? step(1) : rootRef.current?.focus())}
      >
        <img
          alt={copy.slides.page(page)}
          className={cn(
            'max-h-full max-w-full object-contain select-none',
            !fullscreen && 'rounded-md bg-white shadow-[0_6px_24px_rgba(0,0,0,0.12)]'
          )}
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
        {fullscreen && (
          <>
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
          </>
        )}
      </div>
      {!fullscreen && pages > 1 && (
        <div
          className="flex h-[4.75rem] shrink-0 gap-2 overflow-x-auto border-t border-border/40 px-3 py-2"
          ref={stripRef}
        >
          {Array.from({ length: pages }, (_, i) => i + 1).map(n => (
            <button
              aria-current={n === page ? 'true' : undefined}
              aria-label={copy.slides.page(n)}
              className={cn(
                'h-full shrink-0 overflow-hidden rounded-sm border bg-white transition',
                n === page ? 'border-primary ring-2 ring-primary/30' : 'border-border/60 opacity-70 hover:opacity-100'
              )}
              data-slide={n}
              key={n}
              onClick={() => go(n)}
              style={{ aspectRatio: ratio }}
              type="button"
            >
              <img alt="" className="size-full object-cover" draggable={false} loading="lazy" src={src(n)} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
