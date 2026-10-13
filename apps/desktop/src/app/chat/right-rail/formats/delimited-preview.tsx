import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { $dirtyPreviewUrls } from '@/store/preview-edit'

import { LocalFilePreview } from '../preview-file'

import { type DelimitedTable, delimiterForPath, parseDelimited } from './delimited-parse'
import type { FormatRendererProps } from './registry'
import { readPreviewText } from './source'

interface DelimitedState {
  loading: boolean
  table?: DelimitedTable
  truncated?: boolean
}

/** 表格只读；源码及编辑交给原版组件，未保存时禁止切走丢失草稿。 */
export default function DelimitedPreview({ onClose, onSelectRendered, reloadKey, target }: FormatRendererProps) {
  const { t } = useI18n()
  const [state, setState] = useState<DelimitedState>({ loading: true })
  const [sourceMode, setSourceMode] = useState(false)
  const dirtyUrls = useStore($dirtyPreviewUrls)
  const path = target.path || target.source || target.url
  const legacyProps = { onClose, onSelectRendered, reloadKey, target }

  useEffect(() => {
    if (sourceMode) {
      return
    }

    let active = true

    void readPreviewText(path).then(
      file => {
        if (!active) {
          return
        }

        try {
          const table = parseDelimited(file.text, delimiterForPath(path), 500, Boolean(file.truncated))
          setState({ loading: false, table, truncated: file.truncated })
        } catch {
          setState({ loading: false })
          setSourceMode(true)
        }
      },
      () => {
        if (active) {
          setState({ loading: false })
          setSourceMode(true)
        }
      }
    )

    return () => {
      active = false
    }
  }, [path, reloadKey, sourceMode])

  /** 返回表格时重新读文件，让源码保存后的内容立即生效。 */
  function toggleView() {
    if (sourceMode) {
      setState({ loading: true })
    }

    setSourceMode(current => !current)
  }

  // 解析失败时完整交还原版文本预览，不显示一个无法恢复的表格错误页。
  if (!state.loading && !state.table) {
    return <LocalFilePreview {...legacyProps} />
  }

  const table = state.table
  const columns = table ? Math.max(table.headers.length, ...table.rows.map(row => row.length)) : 0

  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end border-b border-(--ui-stroke-tertiary) px-3 py-1">
        <Button
          disabled={state.loading || (sourceMode && Boolean(dirtyUrls[target.url]))}
          onClick={toggleView}
          size="xs"
          variant="ghost"
        >
          {sourceMode ? t.preview.delimited.table : t.preview.source}
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {sourceMode ? (
          <LocalFilePreview {...legacyProps} />
        ) : state.loading ? (
          <PageLoader label={t.preview.loading} />
        ) : !columns ? (
          <div className="grid h-full place-items-center text-xs text-muted-foreground">
            {t.preview.delimited.empty}
          </div>
        ) : (
          <div className="h-full overflow-auto">
            <table aria-label={target.label} className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-background text-foreground">
                <tr>
                  <th className="border-b border-(--ui-stroke-tertiary) px-3 py-2 text-right font-normal">#</th>
                  {Array.from({ length: columns }, (_, column) => (
                    <th
                      className="border-b border-(--ui-stroke-tertiary) px-3 py-2 text-left font-medium whitespace-pre-wrap"
                      key={column}
                      scope="col"
                    >
                      {table?.headers[column] || column + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table?.rows.map((row, index) => (
                  <tr className="align-top even:bg-muted/25" key={index}>
                    <th className="px-3 py-2 text-right font-normal text-muted-foreground" scope="row">
                      {index + 1}
                    </th>
                    {Array.from({ length: columns }, (_, column) => (
                      <td className="max-w-80 px-3 py-2 whitespace-pre-wrap wrap-break-word" key={column}>
                        {row[column] || ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {!sourceMode && (state.truncated || table?.limited) && (
        <div className="shrink-0 px-3 py-2 text-xs text-muted-foreground" role="status">
          {state.truncated && <div>{t.preview.truncated}</div>}
          {table?.limited && <div>{t.preview.delimited.limited}</div>}
        </div>
      )}
    </div>
  )
}
