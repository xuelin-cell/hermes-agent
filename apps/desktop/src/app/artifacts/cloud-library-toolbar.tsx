import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { useI18n } from '@/i18n'
import { Plus, RefreshCw, Search, Trash2 } from '@/lib/icons'

import { driveBytes, type DriveUsage } from './use-drive-usage'

export type CloudLibraryFilter = 'all' | 'file' | 'directory' | 'recycle'

interface CloudLibraryToolbarProps {
  transferControl?: ReactNode
  filter: CloudLibraryFilter
  query: string
  usage: DriveUsage | null
  usageFailed: boolean
  connected: boolean
  busy: boolean
  refreshing: boolean
  canUpload: boolean
  canCreate: boolean
  canEmpty: boolean
  onFilter: (value: CloudLibraryFilter) => void
  onQuery: (value: string) => void
  onUpload: () => void
  onCreate: () => void
  onRefresh: () => void
  onEmpty: () => void
}

/** 上排只放筛选、容量和文件操作；面包屑及多选统一留给下排。 */
export function CloudLibraryToolbar(props: CloudLibraryToolbarProps) {
  const { t } = useI18n()
  const copy = t.cloudLibrary

  const options = [
    { id: 'all', label: copy.filterAll },
    { id: 'file', label: copy.filterFiles },
    { id: 'directory', label: copy.filterFolders },
    { id: 'recycle', label: copy.recycle }
  ] as const

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border/70 px-4 py-2">
      <div aria-label={copy.filter} className="flex items-center gap-1" role="group">
        {options.map(option => (
          <Button
            aria-pressed={props.filter === option.id}
            disabled={!props.connected || props.busy}
            key={option.id}
            onClick={() => props.onFilter(option.id)}
            size="sm"
            variant={props.filter === option.id ? 'secondary' : 'ghost'}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <div
        className="mx-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground @max-[48rem]/drive:flex-col @max-[48rem]/drive:items-start @max-[48rem]/drive:gap-1"
        title={props.usageFailed ? copy.usageRefreshFailed : undefined}
      >
        <span className="whitespace-nowrap">
          {props.usage
            ? copy.usage(driveBytes(props.usage.used_bytes), driveBytes(props.usage.total_bytes))
            : copy.usageUnknown}
        </span>
        {props.usage?.used_bytes != null && props.usage.total_bytes != null && props.usage.total_bytes > 0 && (
          <Progress
            aria-label={copy.usageLabel}
            className="w-20 shrink-0"
            size="sm"
            value={props.usage.used_bytes / props.usage.total_bytes}
          />
        )}
      </div>
      <div className="flex min-h-10 flex-wrap items-center justify-end gap-2 @max-[64rem]/drive:w-full">
        {props.filter === 'recycle' ? (
          <Button
            disabled={!props.canEmpty || props.busy || props.refreshing}
            onClick={props.onEmpty}
            size="sm"
            variant="outline"
          >
            <Trash2 />
            {copy.emptyRecycle}
          </Button>
        ) : (
          <>
            <Input
              aria-label={copy.search}
              containerClassName="w-52 max-w-full"
              disabled={props.busy}
              onChange={event => props.onQuery(event.target.value)}
              placeholder={copy.search}
              prefix={<Search />}
              value={props.query}
            />
            <Button disabled={!props.canUpload || props.busy} onClick={props.onUpload} size="sm" variant="outline">
              <Plus />
              {copy.upload}
            </Button>
            <Button disabled={!props.canCreate || props.busy} onClick={props.onCreate} size="sm" variant="outline">
              <Plus />
              {copy.createFolder}
            </Button>
          </>
        )}
        {props.transferControl}
        <Button
          aria-busy={props.refreshing}
          aria-label={copy.refresh}
          disabled={props.refreshing || props.busy}
          onClick={props.onRefresh}
          size="icon-xs"
          variant="ghost"
        >
          <RefreshCw className={props.refreshing ? 'animate-spin motion-reduce:animate-none' : undefined} />
        </Button>
      </div>
    </div>
  )
}

import type { ReactNode } from 'react'
