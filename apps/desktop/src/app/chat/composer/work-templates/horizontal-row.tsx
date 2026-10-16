import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight, iconSize } from '@/lib/icons'

interface HorizontalRowProps {
  children: ReactNode
  contentKey: string
  leftLabel: string
  rightLabel: string
}

/** 分类和模板共用横向滚动；仅在尚有内容时提供箭头，不拦截边界外的页面滚动。 */
export function HorizontalRow({ children, contentKey, leftLabel, rightLabel }: HorizontalRowProps) {
  const viewport = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })

  /** 按可见宽度更新箭头，窗口和内容变化都重新测量。 */
  const measure = useCallback(() => {
    const node = viewport.current

    if (node) {
      setEdges({ left: node.scrollLeft > 1, right: node.scrollLeft + node.clientWidth < node.scrollWidth - 1 })
    }
  }, [])

  /** 分页移动大部分可见内容，保留位置连续感。 */
  const scroll = (direction: number) => {
    const node = viewport.current
    node?.scrollBy({
      left: direction * Math.max(node.clientWidth * 0.75, 160),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    })
  }

  useEffect(() => {
    const node = viewport.current

    if (!node) {
      return
    }

    node.scrollTo({ left: 0 })
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)

    return () => observer?.disconnect()
  }, [contentKey, measure])
  useEffect(() => {
    const node = viewport.current

    if (!node) {
      return
    }

    /** 使用非被动监听，只在列表能继续移动时接管纵向滚轮。 */
    const wheel = (event: WheelEvent) => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      const amount = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1)

      if (
        (amount < 0 && node.scrollLeft > 1) ||
        (amount > 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1)
      ) {
        event.preventDefault()
        node.scrollBy({ left: amount, behavior: 'auto' })
      }
    }

    node.addEventListener('wheel', wheel, { passive: false })

    return () => node.removeEventListener('wheel', wheel)
  }, [])

  return (
    <div className="flex w-full min-w-0 items-center gap-2" dir="ltr">
      {edges.left && (
        <Button
          aria-label={leftLabel}
          className="rounded-full"
          onClick={() => scroll(-1)}
          size="icon-sm"
          type="button"
          variant="chip"
        >
          <ChevronLeft className={iconSize.md} />
        </Button>
      )}
      <div
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={measure}
        ref={viewport}
      >
        {children}
      </div>
      {edges.right && (
        <Button
          aria-label={rightLabel}
          className="rounded-full"
          onClick={() => scroll(1)}
          size="icon-sm"
          type="button"
          variant="chip"
        >
          <ChevronRight className={iconSize.md} />
        </Button>
      )}
    </div>
  )
}
