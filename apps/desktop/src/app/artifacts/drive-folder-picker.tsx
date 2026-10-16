import { useState } from 'react'

import type { DriveAsset } from '@/api/drive'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ChevronLeft, ChevronRight, FolderOpen } from '@/lib/icons'

import { DriveBreadcrumbs } from './drive-breadcrumbs'
import type { DriveFolderLocation } from './drive-directory-index'

interface DriveFolderPickerProps {
  root: string
  parent: string
  path: DriveFolderLocation[] | null
  items: DriveAsset[]
  complete: boolean
  emptyHint?: string
  showPartialHint?: boolean
  disabled: boolean
  onNavigate: (id: string) => void
}

const PAGE_SIZE = 50

/** 复用完整目录索引分页选择目标，固定目录区高度，导航不再发起另一套扫描。 */
export function DriveFolderPicker({
  root,
  parent,
  path,
  items,
  complete,
  emptyHint,
  showPartialHint = true,
  disabled,
  onNavigate
}: DriveFolderPickerProps) {
  const { t } = useI18n()
  const copy = t.cloudLibrary
  const [pagination, setPagination] = useState({ parent, page: 1 })

  const folders = items
    .filter(item => item.kind === 'directory' && item.parent_asset_id === parent && item.permissions?.read !== false)
    .sort((left, right) => left.name.localeCompare(right.name))

  const pages = Math.max(1, Math.ceil(folders.length / PAGE_SIZE))
  const page = pagination.parent === parent ? Math.min(pagination.page, pages) : 1
  const rows = folders.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const targetName = path?.at(-1)?.name || copy.personal
  const ancestor = path && path.length > 1 ? path.at(-2)!.id : root

  /** 切换目录重置分页；重新进入父目录时不沿用之前停留的末页。 */
  function navigate(id: string): void {
    setPagination({ parent: id, page: 1 })
    onNavigate(id)
  }

  return (
    <div className="flex h-80 max-h-[45vh] min-h-0 flex-col overflow-hidden">
      <div className="mb-1 flex h-8 shrink-0 items-center overflow-x-auto">
        <DriveBreadcrumbs disabled={disabled} onNavigate={navigate} path={path || []} root={root} />
      </div>
      {parent !== root && (
        <Button className="w-full justify-start" disabled={disabled} onClick={() => navigate(ancestor)} variant="ghost">
          <ChevronLeft aria-hidden="true" />
          {copy.parentFolder}
        </Button>
      )}
      <div aria-label={copy.destination} className="min-h-0 flex-1 overflow-y-auto" role="region">
        {!complete && showPartialHint && <p className="px-3 py-4 text-center text-xs text-muted-foreground">{copy.partialHint}</p>}
        {path === null ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground" role="alert">
            {copy.loadFailed}
          </p>
        ) : !folders.length && complete ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">{emptyHint || copy.noSubfolders}</p>
        ) : (
          rows.map(folder => (
            <Button
              className="w-full justify-start"
              disabled={disabled}
              key={folder.asset_id}
              onClick={() => navigate(folder.asset_id)}
              variant="ghost"
            >
              <FolderOpen aria-hidden="true" className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left">{folder.name}</span>
              <ChevronRight aria-hidden="true" className="text-muted-foreground" />
            </Button>
          ))
        )}
      </div>
      <div className="mt-2 flex h-8 shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={targetName}>
          {copy.destinationIs(targetName)}
        </span>
        <Tip label={t.ui.pagination.previous}>
          <Button
            aria-label={t.ui.pagination.previous}
            disabled={disabled || page === 1}
            onClick={() => setPagination({ parent, page: page - 1 })}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
        </Tip>
        <Tip label={t.ui.pagination.next}>
          <Button
            aria-label={t.ui.pagination.next}
            disabled={disabled || page === pages}
            onClick={() => setPagination({ parent, page: page + 1 })}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </Tip>
      </div>
    </div>
  )
}
