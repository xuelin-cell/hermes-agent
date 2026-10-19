import type { Sheet } from '@fortune-sheet/core'
import { Workbook } from '@fortune-sheet/react'
import fortuneStyles from '@fortune-sheet/react/dist/index.css?raw'
import { type SyntheticEvent, useEffect, useRef, useState, type WheelEvent } from 'react'

import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'

import { previewFailure } from './failure'
import type { FormatRendererProps } from './registry'
import { toFortuneWorkbook } from './sheet/fortune'
import { validateWorkbookImages } from './sheet/images'
import { parseWorkbook } from './sheet/model'
import { readPreviewBytes } from './source'

// 表格组件的样式表带有全局规则（label 光标、整页滚动条按钮）。放进无前缀的 @scope 后，只作用于 <style> 所在的预览区域。
const SCOPED_STYLES = `@scope {${fortuneStyles}}`

/** 库的只读开关不覆盖图片编辑，阻止图片选择、拖动及键盘编辑，普通表格仍可交互。 */
function preventImageEditing(event: SyntheticEvent) {
  if ('key' in event && event.key === 'Tab') {
    return
  }

  if (event.target instanceof Element && event.target.closest('#luckysheet-image-showBoxs')) {
    event.preventDefault()
    event.stopPropagation()
  }
}

/** 原库按整数行边界定位；向上滚动前消除显示缩放造成的分数像素越界。 */
function correctWheelPosition(event: WheelEvent<HTMLDivElement>) {
  if (event.deltaY >= 0) {
    return
  }

  const scrollbar = event.currentTarget.querySelector<HTMLElement>('.luckysheet-scrollbar-y')

  if (scrollbar && scrollbar.scrollTop % 1 !== 0) {
    // 留在边界内侧，避免 Chromium 再次把目标位置量化到边界上方；不接管库的滚动规则。
    scrollbar.scrollTop = Math.max(0, Math.floor(scrollbar.scrollTop) - 1)
  }
}

/** 只读工作簿；读取失败交给登记表的 PDF 候选，过期结果不能覆盖新文件。 */
export default function SheetPreview({ onFailure, path, reloadKey, target }: FormatRendererProps) {
  const { locale, t } = useI18n()
  const root = useRef<HTMLDivElement>(null)
  const [result, setResult] = useState<{ sheets: Sheet[]; limited: boolean } | null>(null)

  useEffect(() => {
    let active = true
    setResult(null)
    void readPreviewBytes(path)
      .then(async bytes => {
        if (!active) {
          return
        }

        const parsed = parseWorkbook(bytes)

        if (parsed.some(sheet => sheet.charts?.length)) {
          const { renderWorkbookCharts } = await import('./sheet/charts-render')

          if (!active) {
            return
          }

          renderWorkbookCharts(parsed)
        }

        await validateWorkbookImages(parsed)

        if (active) {
          setResult({ sheets: toFortuneWorkbook(parsed), limited: parsed.some(sheet => sheet.limited) })
        }
      })
      .catch(error => {
        if (active) {
          onFailure(previewFailure(error))
        }
      })

    return () => {
      active = false
    }
  }, [onFailure, path, reloadKey])

  useEffect(() => {
    const container = root.current!
    let width = container.clientWidth
    let height = container.clientHeight
    let timer = 0
    let windowResized = 0
    let synthetic: Event | undefined

    /** 记下不是本组件补发的窗口尺寸变化；表格组件已经收到这类事件，不必再补发。 */
    function onWindowResize(event: Event) {
      if (event !== synthetic) {
        windowResized = performance.now()
      }
    }

    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect

      if (next.width === width && next.height === height) {
        return
      }

      width = next.width
      height = next.height
      window.clearTimeout(timer)

      if (performance.now() - windowResized < 100) {
        return
      }

      // FortuneSheet 只监听 window.resize，拖动分隔条不产生该事件；停下来后补发一次，不在拖动中每帧打扰整个应用。
      timer = window.setTimeout(() => window.dispatchEvent((synthetic = new Event('resize'))), 150)
    })

    window.addEventListener('resize', onWindowResize)
    observer.observe(container)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      window.clearTimeout(timer)
    }
  }, [])

  return (
    <div
      aria-label={target.label}
      className="flex size-full min-h-0 flex-col"
      onClickCapture={preventImageEditing}
      onContextMenuCapture={preventImageEditing}
      onKeyDownCapture={preventImageEditing}
      onMouseDownCapture={preventImageEditing}
      onWheelCapture={correctWheelPosition}
      ref={root}
      role="region"
    >
      <style>{SCOPED_STYLES}</style>
      <div className="relative min-h-0 flex-1">
        {result ? (
          <Workbook
            addRows={0}
            allowEdit={false}
            cellContextMenu={[]}
            columnHeaderHeight={28}
            data={result.sheets}
            devicePixelRatio={Math.min(window.devicePixelRatio || 1, 2)}
            filterContextMenu={[]}
            forceCalculation={false}
            headerContextMenu={[]}
            key={locale}
            lang={locale === 'zh-hant' ? 'zh-TW' : locale}
            rowHeaderWidth={46}
            sheetTabContextMenu={[]}
            showFormulaBar={false}
            showSheetTabs
            showToolbar={false}
          />
        ) : (
          <PageLoader label={t.preview.loading} />
        )}
      </div>
      {result?.limited && (
        <p className="shrink-0 px-3 py-1 text-xs text-muted-foreground" role="status">
          {t.preview.sheetLimited}
        </p>
      )}
    </div>
  )
}
