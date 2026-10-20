import { useEffect, useMemo, useRef, useState } from 'react'

import { $apiRequestScope } from '@/api/client'
import { type DriveAsset, driveRequest } from '@/api/drive'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useI18n } from '@/i18n'
import { desktopFsCacheKey } from '@/lib/desktop-fs'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import { openPreview } from '@/store/preview'

import { CloudDirectoryEmpty, CloudDriveLoading } from './cloud-directory-empty'
import { CloudFileListHeader } from './cloud-file-list-header'
import { type CloudFileSort, sortCloudFiles } from './cloud-file-metadata'
import { CloudLibraryRow } from './cloud-library-row'
import { type CloudLibraryFilter, CloudLibraryToolbar } from './cloud-library-toolbar'
import { CloudLocationBar } from './cloud-location-bar'
import { CloudNameDialog } from './cloud-name-dialog'
import { cloudPreviewTarget } from './cloud-preview-target'
import { CloudRecycleActionDialog } from './cloud-recycle-action-dialog'
import { CloudRecycleBin } from './cloud-recycle-bin'
import { CloudSelectionActions } from './cloud-selection-actions'
import { CloudTransferFeedback } from './cloud-transfer-feedback'
import { DriveBreadcrumbs } from './drive-breadcrumbs'
import { driveFolderPath, filterDriveFiles } from './drive-directory-index'
import { DriveMoveDialog } from './drive-move-dialog'
import { useCloudDraft } from './use-cloud-draft'
import { useCloudLibraryData } from './use-cloud-library-data'
import { useCloudTransfer } from './use-cloud-transfer'
import { driveMutationMessage } from './use-drive-mutation'
import { useDriveSelection } from './use-drive-selection'
import { useDriveTrash } from './use-drive-trash'
import { useDriveUsage } from './use-drive-usage'

interface CloudLibraryProps {
  onDraftReady?: (route: string) => void
}

/** 云盘组合独立的工具栏、列表与批量动作，账号鉴权和文件传输继续由主进程负责。 */
export function CloudLibrary({ onDraftReady }: CloudLibraryProps = {}) {
  const { t } = useI18n()
  const copy = t.cloudLibrary
  const { snapshot, space, capabilities, error, refresh: refreshFiles, refreshBackground } = useCloudLibraryData()
  const quota = useDriveUsage(space?.space_id)
  const transfer = useCloudTransfer(refresh)
  const draft = useCloudDraft(onDraftReady)
  const previewLifecycle = useRef({ active: true })
  // 目录页面卸载后，迟到的原生文件规范化结果不能重新打开预览。
  useEffect(() => {
    const lifecycle = previewLifecycle.current
    lifecycle.active = true

    return () => {
      lifecycle.active = false
    }
  }, [])
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'file' | 'directory'>('all')
  const [sort, setSort] = useState<CloudFileSort>('default')
  const [visibleCount, setVisibleCount] = useState(50)
  const [editing, setEditing] = useState<DriveAsset | 'new' | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [recycle, setRecycle] = useState(false)
  const [recycleRevision, setRecycleRevision] = useState(0)
  const [recycleLoading, setRecycleLoading] = useState(false)
  const [recycleBusy, setRecycleBusy] = useState(false)
  const [emptyRecycle, setEmptyRecycle] = useState(false)
  const [moving, setMoving] = useState<readonly DriveAsset[] | null>(null)
  const parent = folders.at(-1)?.id || space?.root_asset_id
  const loading = !space && !error

  const visible = useMemo(
    () =>
      space && parent
        ? sortCloudFiles(
            filterDriveFiles(snapshot.items, space.root_asset_id, parent, query).filter(
              asset => filter === 'all' || asset.kind === filter
            ),
            sort
          )
        : [],
    [snapshot.items, space, parent, query, filter, sort]
  )

  const rows = visible.slice(0, visibleCount)
  const selection = useDriveSelection(JSON.stringify([parent, filter, query, sort]), rows)
  const deletion = useDriveTrash(refresh)
  const busy = transfer.busy || draft.busy || deletion.busy || saving || moving !== null || recycleBusy || emptyRecycle
  const writable = snapshot.items.find(item => item.asset_id === parent)?.permissions?.write !== false

  /** 刷新保留本页列表，同时重读容量；清除旧选择，防止对刷新后的其他文件误操作。 */
  function refresh(): void {
    selection.clear()
    refreshFiles()
    quota.refresh()

    if (recycle) {
      setRecycleRevision(value => value + 1)
    }
  }

  /** 显式改变排序时清除选择并回到首批，保持排序后的文件和批量动作一一对应。 */
  function changeSort(): void {
    selection.clear()
    setVisibleCount(50)
    setSort(previous => (previous === 'default' ? 'desc' : previous === 'desc' ? 'asc' : 'default'))
  }

  /** 切换目录时只调整本页位置，清除原目录的选择和搜索。 */
  function navigate(id: string): void {
    selection.clear()
    setFolders(value => value.slice(0, value.findIndex(folder => folder.id === id) + 1))
    setQuery('')
    setVisibleCount(50)
  }

  /** 筛选与回收站共用上排入口，不把其他范围的勾选带进当前列表。 */
  function changeFilter(value: CloudLibraryFilter): void {
    selection.clear()
    setRecycle(value === 'recycle')

    if (value !== 'recycle') {
      setFilter(value)
      refreshBackground()
      quota.refresh()
    }

    setVisibleCount(50)
  }

  /** 弹窗提交名称，成功后刷新权威列表。 */
  async function saveName() {
    if (
      !name.trim() ||
      !editing ||
      !parent ||
      (editing === 'new' ? !capabilities?.create_folder : !capabilities?.rename || editing.permissions?.write === false)
    ) {
      return
    }

    setSaving(true)

    try {
      await driveRequest(
        editing === 'new' ? '/folders' : `/assets/${encodeURIComponent(editing.asset_id)}`,
        editing === 'new' ? 'POST' : 'PATCH',
        editing === 'new'
          ? { parent_asset_id: parent, name: name.trim() }
          : { new_name: name.trim(), kind: editing.kind }
      )
      setEditing(null)
      refresh()
    } catch (failure) {
      notifyError(new Error(driveMutationMessage(failure, copy)), copy.rename)
      refresh()
    } finally {
      setSaving(false)
    }
  }

  /** 目录只切换列表；文件经原生受控准备后进入 Hermes 右侧预览。 */
  async function open(asset: DriveAsset, download = false) {
    if (asset.permissions?.read === false) {
      return
    }

    if (asset.kind === 'directory') {
      const path = space && driveFolderPath(snapshot.items, space.root_asset_id, asset.asset_id)

      if (path) {
        selection.clear()
        setFolders(path)
        setQuery('')
        setVisibleCount(50)
      }

      return
    }

    if (!capabilities?.download) {
      return
    }

    const scope = $apiRequestScope.get()
    const bridge = window.hermesDesktop
    const owner = desktopFsCacheKey()

    const result = await transfer.start({
      operation: download ? 'download' : 'preview',
      assetId: asset.asset_id,
      name: asset.name,
      size: asset.size_bytes
    })

    if (
      !download &&
      result?.status === 'succeeded' &&
      space &&
      bridge === window.hermesDesktop &&
      scope === $apiRequestScope.get() &&
      owner === desktopFsCacheKey()
    ) {
      const target = await cloudPreviewTarget(space.space_id, asset, result).catch(() => null)

      if (
        previewLifecycle.current.active &&
        bridge === window.hermesDesktop &&
        scope === $apiRequestScope.get() &&
        owner === desktopFsCacheKey()
      ) {
        if (target) {
          openPreview(target)
        } else {
          notifyError(new Error(copy.previewUnsupported), copy.transfers)
        }
      }
    }
  }

  return (
    <section className="@container/drive flex h-full min-h-0 flex-col">
      <CloudLibraryToolbar
        busy={busy}
        canCreate={!!parent && !!capabilities?.create_folder && writable}
        canEmpty={!!capabilities?.trash}
        canUpload={!!parent && !!capabilities?.upload && writable}
        connected={!!space}
        filter={recycle ? 'recycle' : filter}
        onCreate={() => {
          setName('')
          setEditing('new')
        }}
        onEmpty={() => setEmptyRecycle(true)}
        onFilter={changeFilter}
        onQuery={value => {
          selection.clear()
          setQuery(value)
          setVisibleCount(50)
        }}
        onRefresh={refresh}
        onUpload={() => parent && void transfer.start({ operation: 'upload', parentAssetId: parent })}
        query={query}
        refreshing={recycle ? recycleLoading : loading || snapshot.scanning}
        transferControl={<CloudTransferFeedback transfer={transfer} />}
        usage={quota.usage}
        usageFailed={quota.failed}
      />
      {recycle ? (
        <CloudRecycleBin
          canWrite={!!capabilities?.trash}
          embedded
          externalRevision={recycleRevision}
          onBack={() => changeFilter(filter)}
          onChanged={refresh}
          onInteractionChange={setRecycleBusy}
          onLoadingChange={setRecycleLoading}
        />
      ) : (
        <>
          <div className="relative shrink-0">
            <CloudLocationBar
              leading={
                <Checkbox
                  aria-label={copy.selectAll}
                  checked={
                    rows.length > 0 && selection.chosen.length === rows.length
                      ? true
                      : selection.chosen.length
                        ? 'indeterminate'
                        : false
                  }
                  disabled={!rows.length || busy}
                  onCheckedChange={checked => selection.selectAll(checked === true)}
                />
              }
            >
              <div className="flex min-w-0 flex-1 items-center gap-4">
                <div className="min-w-0 flex-[0_1_28rem] @max-[42rem]/drive:relative @max-[42rem]/drive:flex-1">
                  <div className={cn('overflow-x-auto', selection.chosen.length > 0 && '@max-[42rem]/drive:invisible')}>
                    <DriveBreadcrumbs
                      disabled={busy}
                      onNavigate={navigate}
                      path={folders}
                      root={space?.root_asset_id || ''}
                    />
                  </div>
                  {/* 多选栏脱离列宽计算；窄屏占用面包屑区域，避免覆盖元数据。 */}
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 @max-[42rem]/drive:left-0 @max-[42rem]/drive:right-auto">
                    <CloudSelectionActions
                      assets={selection.chosen}
                      busy={busy}
                      canMove={!snapshot.scanning && !snapshot.error}
                      capabilities={capabilities}
                      onAdd={() => void draft.add(selection.chosen)}
                      onClear={selection.clear}
                      onDownload={() =>
                        void transfer.start({
                          operation: 'download-many',
                          assets: selection.chosen.map(asset => ({
                            assetId: asset.asset_id,
                            name: asset.name,
                            size: asset.size_bytes
                          }))
                        })
                      }
                      onMove={() => setMoving([...selection.chosen])}
                      onTrash={() => void deletion.trash(selection.chosen)}
                    />
                  </div>
                </div>
                {space && <CloudFileListHeader disabled={busy} onSort={changeSort} sort={sort} />}
              </div>
              {space && <span aria-hidden="true" className="w-40 shrink-0 @max-[42rem]/drive:w-6" />}
            </CloudLocationBar>
          </div>
          {draft.message && (
            <p className="px-4 py-2 text-sm" role="status">
              {draft.message}
            </p>
          )}
          {space && snapshot.error && (
            <div aria-live="polite" className="px-4 py-2 text-sm text-muted-foreground" role="alert">
              {copy.indexFailed}
              <Button onClick={refresh} size="sm" variant="ghost">
                {copy.refresh}
              </Button>
            </div>
          )}
          {space && !capabilities && (
            <p className="px-4 py-2 text-sm" role="alert">
              {copy.capabilitiesUnavailable}
            </p>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {loading ? (
              <CloudDriveLoading label={copy.connecting} />
            ) : error ? (
              <div role="alert">
                {copy.loadFailed}
                <Button onClick={refresh}>{copy.refresh}</Button>
              </div>
            ) : !visible.length ? (
              <CloudDirectoryEmpty parent={parent} query={query} snapshot={snapshot} />
            ) : (
              rows.map(asset => (
                <CloudLibraryRow
                  asset={asset}
                  busy={busy}
                  canMove={!snapshot.scanning && !snapshot.error}
                  capabilities={capabilities}
                  key={asset.asset_id}
                  onAdd={() => void draft.add(asset)}
                  onMove={() => setMoving([asset])}
                  onOpen={download => void open(asset, download)}
                  onRename={() => {
                    setName(asset.name)
                    setEditing(asset)
                  }}
                  onToggle={() => selection.toggle(asset.asset_id)}
                  onTrash={() => void deletion.trash(asset)}
                  selected={selection.selected.has(asset.asset_id)}
                />
              ))
            )}
            {visible.length > visibleCount && (
              <Button disabled={busy} onClick={() => setVisibleCount(value => value + 50)} size="sm" variant="ghost">
                {copy.loadMore}
              </Button>
            )}
          </div>
        </>
      )}
      <CloudNameDialog
        creating={editing === 'new'}
        name={name}
        onClose={() => setEditing(null)}
        onName={setName}
        onSave={() => void saveName()}
        open={editing !== null}
        saving={saving}
      />
      {emptyRecycle && (
        <CloudRecycleActionDialog
          action={{ kind: 'empty' }}
          onChanged={refresh}
          onClose={() => setEmptyRecycle(false)}
        />
      )}
      {moving && space && (
        <DriveMoveDialog
          asset={moving}
          complete={snapshot.complete}
          items={snapshot.items}
          onChanged={refresh}
          onClose={() => setMoving(null)}
          space={space}
        />
      )}
    </section>
  )
}
