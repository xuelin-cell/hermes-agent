import type { MouseEvent, ReactNode } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// desktop-mt: the PDF viewer's page counter and round toolbar buttons
// (pdf-preview.tsx), kept apart from the viewer so they can be unit-tested.

interface Span {
  bottom: number
  top: number
}

/** The page the counter shows: the one filling most of what the list shows
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

export function RoundButton({
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
    <Tip label={label}>
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
        type="button"
      >
        {children}
      </button>
    </Tip>
  )
}
