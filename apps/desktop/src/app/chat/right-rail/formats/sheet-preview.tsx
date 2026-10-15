import '@fortune-sheet/react/dist/index.css'

import type { Sheet } from '@fortune-sheet/core'
import { Workbook } from '@fortune-sheet/react'
import { type SyntheticEvent, useEffect, useRef, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'

import { previewFailure } from './failure'
import type { FormatRendererProps } from './registry'
import { toFortuneWorkbook } from './sheet/fortune'
import { validateWorkbookImages } from './sheet/images'
import { parseWorkbook } from './sheet/model'
import { readPreviewBytes } from './source'

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
    let frame = 0

    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect

      if (next.width === width && next.height === height) {
        return
      }

      width = next.width
      height = next.height
      cancelAnimationFrame(frame)
      // FortuneSheet 监听 window.resize；分隔条拖动不产生该事件，按帧合并补发。
      frame = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    })

    observer.observe(container)

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
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
      ref={root}
      role="region"
    >
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
