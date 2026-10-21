import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useResizeObserver } from '@/hooks/use-resize-observer'
import { useI18n } from '@/i18n'
import { ChevronLeft, ChevronRight, Maximize, X } from '@/lib/icons'

import { previewFailure } from './failure'
import { openPdfPages, type PdfPages } from './pdf-pages'
import type { FormatRendererProps } from './registry'
import { readOfficePreviewPdf } from './source'

interface Span {
  top: number
  bottom: number
}

/** 沿用 Web 的计数规则：取可见部分最多的一页，平局取前页，滚到底时取末页。 */
export function currentSlide(slides: readonly Span[], view: Span, atEnd: boolean) {
  if (atEnd) {
    return Math.max(1, slides.length)
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

/** 转换后按 PDF 分页显示。 */
function openConvertedPages(path: string, signal: AbortSignal) {
  return readOfficePreviewPdf(path, signal).then(bytes => (signal.aborted ? null : openPdfPages(bytes)))
}

/** 转换仍走唯一来源模块；迟到的解析器也必须关闭，不能留住 Worker 和缓存。 */
export default function SlidesPreview(props: FormatRendererProps) {
  const { t } = useI18n()
  const source = useSlidePages(openConvertedPages, props)

  return source ? (
    <SlidesViewer label={props.target.label} source={source} />
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-3">
      <PageLoader className="h-auto" label={t.preview.office.converting} />
      <p className="text-xs text-muted-foreground">{t.preview.office.firstOpen}</p>
    </div>
  )
}

/** 打开一份分页来源并负责关闭；刷新或卸载后迟到的结果立即释放，失败交给降级流程。 */
export function useSlidePages(
  open: (path: string, signal: AbortSignal) => Promise<PdfPages | null>,
  { onFailure, path, reloadKey }: Pick<FormatRendererProps, 'onFailure' | 'path' | 'reloadKey'>
) {
  const [source, setSource] = useState<PdfPages | null>(null)
  useEffect(() => {
    let active = true
    let owned: PdfPages | null = null
    const request = new AbortController()
    setSource(null)
    void open(path, request.signal)
      .then(next => {
        owned = next

        if (active) {
          setSource(next)
        } else {
          void next?.dispose()
        }
      })
      .catch(error => {
        if (active) {
          onFailure(previewFailure(error))
        }
      })

    return () => {
      active = false
      request.abort()
      void owned?.dispose()
    }
  }, [onFailure, open, path, reloadKey])

  return source
}

interface ViewerProps {
  label: string
  source: PdfPages
}

const STEPS: Record<string, number> = {
  ' ': 1,
  ArrowDown: 1,
  ArrowRight: 1,
  PageDown: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
  PageUp: -1
}

/** 普通模式按需画图，全屏只显示当前页；键盘只在本查看器拥有全屏时接管。 */
export function SlidesViewer({ label, source }: ViewerProps) {
  const { t } = useI18n()
  const copy = t.preview.slides
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [resumeAt, setResumeAt] = useState(0)
  const [page, setPage] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [fullError, setFullError] = useState(false)
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set([1]))
  const [height, setHeight] = useState(0)
  const total = source.pages.length

  // IntersectionObserver 的百分比按宽度计算；以真实高度定义一屏，窄面板也保留五屏。
  useResizeObserver(
    useCallback(() => setHeight(list.current?.clientHeight || 0), []),
    list
  )

  useEffect(() => {
    /** 浏览器退出全屏时也恢复阅读位置，不只处理自己的退出按钮。 */
    function syncFullscreen() {
      const owned = document.fullscreenElement === root.current

      if (fullscreen && !owned) {
        setResumeAt(page)
      }

      setFullscreen(owned)
    }

    document.addEventListener('fullscreenchange', syncFullscreen)

    return () => document.removeEventListener('fullscreenchange', syncFullscreen)
  }, [fullscreen, page])

  useEffect(() => {
    const element = root.current

    return () => {
      if (document.fullscreenElement === element) {
        void document.exitFullscreen().catch(() => undefined)
      }
    }
  }, [])

  useLayoutEffect(() => {
    const view = list.current

    if (!fullscreen && resumeAt && view) {
      const slide = view.querySelector<HTMLElement>(`[data-slide="${resumeAt}"]`)

      if (slide) {
        view.scrollTop += slide.getBoundingClientRect().top - view.getBoundingClientRect().top - 16
      }

      setResumeAt(0)
    }
  }, [fullscreen, resumeAt])

  useEffect(() => {
    if (fullscreen) {
      setNear(new Set())

      return
    }

    const view = list.current!

    const observer = new IntersectionObserver(
      entries => {
        setNear(current => {
          const next = new Set(current)

          for (const entry of entries) {
            const number = Number((entry.target as HTMLElement).dataset.slide)

            if (entry.isIntersecting) {
              next.add(number)
            }
          }

          return next.size === current.size && [...next].every(number => current.has(number)) ? current : next
        })
      },
      { root: view, rootMargin: `${height}px 0px` }
    )

    // 开始绘制与释放使用不同边界，回看相邻几屏不销毁刚画好的图片。
    const release = new IntersectionObserver(
      entries => {
        setNear(current => {
          const next = new Set(current)

          for (const entry of entries) {
            if (!entry.isIntersecting) {
              next.delete(Number((entry.target as HTMLElement).dataset.slide))
            }
          }

          return next.size === current.size ? current : next
        })
      },
      { root: view, rootMargin: `${height * 5}px 0px` }
    )

    view.querySelectorAll('[data-slide]').forEach(element => {
      observer.observe(element)
      release.observe(element)
    })

    return () => {
      observer.disconnect()
      release.disconnect()
    }
  }, [fullscreen, height, source])

  /** 按真实页面位置更新计数，不改变用户的滚动位置。 */
  function onScroll() {
    const view = list.current!
    const spans = Array.from(view.querySelectorAll('[data-slide]'), element => element.getBoundingClientRect())
    setPage(
      currentSlide(
        spans,
        view.getBoundingClientRect(),
        view.scrollTop > 0 && view.scrollTop + view.clientHeight >= view.scrollHeight - 2
      )
    )
  }

  /** 翻页始终限制范围，按钮操作后把键盘交回放映区域。 */
  function go(next: number) {
    setPage(Math.max(1, Math.min(total, next)))
    root.current?.focus()
  }

  /** 请求失败只说明全屏不可用，不销毁仍能阅读的幻灯片。 */
  async function toggleFullscreen() {
    try {
      setFullError(false)

      if (document.fullscreenElement === root.current) {
        await document.exitFullscreen()
      } else {
        await root.current!.requestFullscreen()
        root.current?.focus()
      }
    } catch {
      setFullError(true)
    }
  }

  /** 不截获修饰键或控件的按键；退出只消费一次，不再冒泡到聊天快捷键。 */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!fullscreen || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return
    }

    if (event.key === 'Escape') {
      void toggleFullscreen()
    } else {
      if ((event.target as HTMLElement).closest('button,input,textarea,[contenteditable="true"]')) {
        return
      }

      if (event.key === 'Home') {
        go(1)
      } else if (event.key === 'End') {
        go(total)
      } else if (Object.hasOwn(STEPS, event.key)) {
        go(page + STEPS[event.key] * (event.shiftKey && event.key === ' ' ? -1 : 1))
      } else {
        return
      }
    }

    event.preventDefault()
    event.stopPropagation()
  }

  const actions = [
    ...(fullscreen
      ? [
          { label: copy.previous, disabled: page <= 1, action: () => go(page - 1), icon: ChevronLeft },
          { label: copy.next, disabled: page >= total, action: () => go(page + 1), icon: ChevronRight }
        ]
      : []),
    {
      label: fullscreen ? copy.exitFullscreen : copy.fullscreen,
      disabled: false,
      action: () => void toggleFullscreen(),
      icon: fullscreen ? X : Maximize
    }
  ]

  return (
    <div
      aria-label={label}
      className="flex size-full min-h-0 flex-col bg-background outline-none"
      onKeyDown={onKeyDown}
      ref={root}
      role="region"
      tabIndex={-1}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-(--ui-stroke-tertiary) px-3 py-1 text-xs text-muted-foreground">
        <span data-slide-counter="">{copy.counter(page, total)}</span>
        <div className="flex items-center gap-1">
          {actions.map(({ label, disabled, action, icon: Icon }) => (
            <Tip key={label} label={label}>
              <Button aria-label={label} disabled={disabled} onClick={action} size="icon-xs" variant="ghost">
                <Icon />
              </Button>
            </Tip>
          ))}
        </div>
      </div>
      {fullError && (
        <p className="px-3 py-1 text-xs text-muted-foreground" role="status">
          {copy.fullscreenFailed}
        </p>
      )}
      <div
        className="min-h-0 flex-1 overflow-y-auto p-4"
        hidden={fullscreen}
        onScroll={onScroll}
        ref={list}
        tabIndex={0}
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-4">
          {source.pages.map((size, index) => (
            <div
              className="w-full shrink-0 overflow-hidden bg-muted"
              data-slide={index + 1}
              key={index}
              style={{ aspectRatio: `${size.width}/${size.height}` }}
            >
              {near.has(index + 1) && (
                <SlideImage className="size-full object-contain" number={index + 1} source={source} />
              )}
            </div>
          ))}
        </div>
      </div>
      {fullscreen && (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
          <SlideImage className="max-h-full max-w-full object-contain" number={page} source={source} />
        </div>
      )}
    </div>
  )
}

/** 图片持有自己的地址，下一张就绪前保留旧图；后台缓存淘汰不影响仍显示的页。 */
function SlideImage({
  source,
  number,
  className
}: Pick<ViewerProps, 'source'> & { number: number; className: string }) {
  const { t } = useI18n()
  const [url, setUrl] = useState(() => source.cachedPage(number) || '')
  const [broken, setBroken] = useState(false)
  const owned = useRef<string | undefined>(undefined)
  useEffect(
    () => () => {
      if (owned.current) {
        URL.revokeObjectURL(owned.current)
      }
    },
    []
  )
  // eslint-disable-next-line no-restricted-syntax -- 持有待释放的 Blob 资源句柄，不是响应式状态镜像。
  useEffect(() => {
    let active = true
    setBroken(false)
    void source
      .renderPage(number)
      .then(async image => {
        if (!active) {
          return
        }

        const blob = await (await fetch(image)).blob()

        if (active) {
          const next = URL.createObjectURL(blob)
          const previous = owned.current
          owned.current = next
          setUrl(next)

          if (previous) {
            URL.revokeObjectURL(previous)
          }
        }
      })
      .catch(() => {
        if (active) {
          setBroken(true)
        }
      })

    return () => {
      active = false
    }
  }, [number, source])

  if (broken) {
    return (
      <div
        className="flex size-full items-center justify-center p-4 text-center text-xs text-muted-foreground"
        role="status"
      >
        {t.preview.slides.pageFailed(number)}
      </div>
    )
  }

  return url ? (
    <img
      alt={t.preview.slides.page(number)}
      className={className}
      draggable={false}
      onError={() => setBroken(true)}
      src={url}
    />
  ) : (
    <PageLoader label={t.preview.loading} />
  )
}
