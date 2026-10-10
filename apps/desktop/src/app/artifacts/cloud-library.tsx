import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { driveApi, type DriveAsset } from '@/api/drive'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Cloud, FolderOpen, Pencil, Plus, RefreshCw, Search, Trash2 } from '@/lib/icons'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { notifyError } from '@/store/notifications'
import { openPreview } from '@/store/preview'

function bytes(value: null | number) {
  if (value == null) {return '—'}
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)))

  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}

export function CloudLibrary() {
  const [rootId, setRootId] = useState('')
  const spaceIdRef = useRef('')
  const rootIdRef = useRef('')
  const [path, setPath] = useState<Array<{ id: string; name: string }>>([])
  const [items, setItems] = useState<DriveAsset[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [previewingId, setPreviewingId] = useState<string | null>(null)

  const parentId = path.at(-1)?.id || rootId

  const load = useCallback(async () => {
    setLoading(true)

    try {
      let nextSpace = spaceIdRef.current
      let nextRoot = rootIdRef.current

      if (!nextSpace || !nextRoot) {
        const spaces = await driveApi.spaces()
        const personal = spaces.items.find(space => space.kind === 'personal')

        if (!personal) {throw new Error('未找到个人云盘空间')}
        nextSpace = personal.space_id
        nextRoot = personal.root_asset_id
        spaceIdRef.current = nextSpace
        rootIdRef.current = nextRoot
        setRootId(nextRoot)
      }

      const listing = await driveApi.list(nextSpace, path.at(-1)?.id || nextRoot)
      setItems(listing.items)
    } catch (error) {
      setItems([])
      notifyError(error, '个人云盘加载失败')
    } finally {
      setLoading(false)
    }
  }, [path])

  useEffect(() => void load(), [load, revision])

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()

    return normalized ? items.filter(item => item.name.toLocaleLowerCase().includes(normalized)) : items
  }, [items, query])

  const createFolder = async () => {
    const name = window.prompt('新建文件夹名称')?.trim()

    if (!name || !parentId) {return}

    try {
      await driveApi.createFolder(parentId, name)
      setRevision(value => value + 1)
    } catch (error) {
      notifyError(error, '新建文件夹失败')
    }
  }

  const rename = async (asset: DriveAsset) => {
    const name = window.prompt('重命名', asset.name)?.trim()

    if (!name || name === asset.name) {return}

    try {
      await driveApi.rename(asset, name)
      setRevision(value => value + 1)
    } catch (error) {
      notifyError(error, '重命名失败')
    }
  }

  const remove = async (asset: DriveAsset) => {
    if (!window.confirm(`将“${asset.name}”移入回收站？`)) {return}

    try {
      await driveApi.trash([asset])
      setRevision(value => value + 1)
    } catch (error) {
      notifyError(error, '移入回收站失败')
    }
  }

  const openAsset = async (asset: DriveAsset) => {
    if (asset.kind === 'directory') {
      setPath(current => [...current, { id: asset.asset_id, name: asset.name }])

      return
    }

    setPreviewingId(asset.asset_id)
    try {
      const staged = await driveApi.preview(asset)
      const target = await normalizeOrLocalPreviewTarget(staged.path)

      if (!target) {throw new Error('无法识别该文件的预览格式')}
      openPreview({ ...target, label: asset.name }, 'file-browser')
    } catch (error) {
      notifyError(error, '文件预览失败')
    } finally {
      setPreviewingId(null)
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-4">
        <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <button className="hover:text-foreground" onClick={() => setPath([])} type="button">个人云盘</button>
          {path.map((folder, index) => (
            <span className="flex min-w-0 items-center gap-1" key={folder.id}>
              <span>/</span>
              <button className="max-w-32 truncate hover:text-foreground" onClick={() => setPath(current => current.slice(0, index + 1))} type="button">{folder.name}</button>
            </span>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Input className="w-52" onChange={event => setQuery(event.target.value)} placeholder="搜索当前文件夹" prefix={<Search className="size-3.5" />} value={query} />
          <Button onClick={() => void createFolder()} size="sm" variant="outline"><Plus />新建文件夹</Button>
          <Button aria-label="刷新" onClick={() => setRevision(value => value + 1)} size="icon-xs" variant="ghost"><RefreshCw /></Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <PageLoader className="h-48" label="正在加载资料库" />
        ) : visible.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div><Cloud className="mx-auto size-8 text-muted-foreground/60" /><p className="mt-3 text-sm font-medium">{query ? '没有匹配的文件' : '个人云盘暂无文件'}</p><p className="mt-1 text-xs text-muted-foreground">云端文件和文件夹会显示在这里</p></div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border/70">
            <div className="grid grid-cols-[minmax(0,1fr)_7rem_10rem_8rem] bg-muted/35 px-3 py-2 text-[11px] text-muted-foreground"><span>名称</span><span>大小</span><span>修改时间</span><span className="text-right">操作</span></div>
            {visible.map(asset => (
              <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_7rem_10rem_8rem] items-center border-t border-border/60 px-3 text-xs hover:bg-muted/25" key={asset.asset_id}>
                <button className="flex min-w-0 items-center gap-2 text-left font-medium hover:text-primary disabled:opacity-60" disabled={previewingId === asset.asset_id} onClick={() => void openAsset(asset)} type="button"><FolderOpen className={asset.kind === 'directory' ? 'size-4 text-amber-400' : 'size-4 text-muted-foreground'} /><span className="truncate">{asset.name}</span>{previewingId === asset.asset_id && <RefreshCw className="size-3 animate-spin text-muted-foreground" />}</button>
                <span className="text-muted-foreground">{asset.kind === 'directory' ? '—' : bytes(asset.size_bytes)}</span>
                <span className="text-muted-foreground">{asset.modified_at ? new Date(asset.modified_at).toLocaleDateString() : '—'}</span>
                <div className="flex justify-end gap-1">
                  <Button aria-label="重命名" onClick={() => void rename(asset)} size="icon-xs" variant="ghost"><Pencil /></Button>
                  <Button aria-label="移入回收站" onClick={() => void remove(asset)} size="icon-xs" variant="ghost"><Trash2 /></Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
