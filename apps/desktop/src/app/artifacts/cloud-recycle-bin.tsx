import { useEffect, useRef, useState } from 'react'

import { type DriveRecycleItem, listDriveRecycle } from '@/api/drive-file-management'
import { PanelEmpty } from '@/app/overlays/panel'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ArrowBackUp, RefreshCw, Trash2 } from '@/lib/icons'
import { fmtDayTime } from '@/lib/time'

import { CloudDriveLoading } from './cloud-directory-empty'
import { CloudFileName, CloudFileRow } from './cloud-file-row'
import { CloudLocationBar } from './cloud-location-bar'
import { CloudRecycleActionDialog, type RecycleAction } from './cloud-recycle-action-dialog'
import { DriveBreadcrumbs } from './drive-breadcrumbs'

interface CloudRecycleBinProps {
  onBack: () => void
  onChanged: () => void
  embedded?: boolean
  externalRevision?: number
  onLoadingChange?: (loading: boolean) => void
  onInteractionChange?: (busy: boolean) => void
  canWrite?: boolean
}

/** 个人回收站保留缓存并刷新列表，恢复和彻底删除都需单独确认。 */
export function CloudRecycleBin({
  onBack,
  onChanged,
  embedded,
  externalRevision,
  onLoadingChange,
  onInteractionChange,
  canWrite = false
}: CloudRecycleBinProps) {
  const { t } = useI18n()
  const copy = t.cloudLibrary
  const [rows, setRows] = useState<DriveRecycleItem[]>([])
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [selected, setSelected] = useState<RecycleAction | null>(null)
  const seen = useRef(new Set<string>())

  useEffect(() => {
    onInteractionChange?.(selected !== null)

    return () => onInteractionChange?.(false)
  }, [selected, onInteractionChange])

  useEffect(() => {
    setPage(1)
  }, [externalRevision])
  useEffect(() => {
    onLoadingChange?.(loading)
  }, [loading, onLoadingChange])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)

    void listDriveRecycle(page)
      .then(items => {
        if (cancelled) {
          return
        }

        if (page === 1) {
          seen.current.clear()
        }

        const added = [...new Map(items.map(item => [item.deleteNo, item])).values()].filter(
          item => !seen.current.has(item.deleteNo)
        )

        if (items.length && !added.length) {
          setError(true)
          setMore(false)

          return
        }

        added.forEach(item => seen.current.add(item.deleteNo))
        setRows(previous => (page === 1 ? added : [...previous, ...added]))
        // 上游可能限制实际页长，短页仍保留下一页入口，直到明确读到空页。
        setMore(items.length > 0)
      })
      .catch(() => {
        if (!cancelled) {
          setError(true)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [page, revision, externalRevision])

  /** 刷新重读第一页，失败时保留原列表供用户核对。 */
  function refresh(): void {
    setPage(1)
    setRevision(value => value + 1)
  }

  /** 恢复后同时刷新回收站和云盘索引。 */
  function changed(): void {
    refresh()
    onChanged()
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <CloudLocationBar>
        <DriveBreadcrumbs
          onNavigate={id => id === 'personal' && onBack()}
          path={[{ id: 'recycle', name: copy.recycle }]}
          root="personal"
        />
        {!embedded && (
          <Button
            aria-busy={loading}
            aria-label={copy.refresh}
            className="ml-auto"
            disabled={loading}
            onClick={refresh}
            size="icon-xs"
            variant="ghost"
          >
            <RefreshCw className={loading ? 'animate-spin motion-reduce:animate-none' : undefined} />
          </Button>
        )}
      </CloudLocationBar>
      {error && (
        <p className="px-4 py-2 text-sm" role="alert">
          {copy.recycleFailed}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {loading && !rows.length ? (
          <CloudDriveLoading label={copy.loading} />
        ) : (
          rows.map(item => (
            <CloudFileRow key={item.deleteNo} name={item.name}>
              <CloudFileName kind={item.kind} name={item.name} />
              {item.deletedAt && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {fmtDayTime.format(new Date(item.deletedAt))}
                </span>
              )}
              <Tip label={copy.restore}>
                <Button
                  aria-label={copy.restore}
                  disabled={loading || error || !canWrite || selected !== null}
                  onClick={() => setSelected({ kind: 'restore', item })}
                  size="icon-xs"
                  variant="ghost"
                >
                  <ArrowBackUp aria-hidden="true" />
                </Button>
              </Tip>
              <Tip label={copy.permanentDelete}>
                <Button
                  aria-label={copy.permanentDelete}
                  className="text-destructive"
                  disabled={loading || error || !canWrite || selected !== null}
                  onClick={() => setSelected({ kind: 'delete', item })}
                  size="icon-xs"
                  variant="ghost"
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </Tip>
            </CloudFileRow>
          ))
        )}
        {!loading && !error && !rows.length && <PanelEmpty icon="trash" title={copy.recycleEmpty} />}
        {!loading && !error && more && (
          <Button onClick={() => setPage(page + 1)} size="sm" variant="ghost">
            {copy.loadMore}
          </Button>
        )}
      </div>
      {selected && <CloudRecycleActionDialog action={selected} onChanged={changed} onClose={() => setSelected(null)} />}
    </section>
  )
}
