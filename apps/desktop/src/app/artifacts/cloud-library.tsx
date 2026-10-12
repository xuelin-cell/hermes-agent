import { useEffect, useState } from 'react'

import { type DriveAsset, driveDownload, driveRequest } from '@/api/drive'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { Download, FolderOpen, Pencil, Plus, RefreshCw, Search, Trash2 } from '@/lib/icons'
import { confirm } from '@/store/confirm'
import { notifyError } from '@/store/notifications'
import { openPreview } from '@/store/preview'

interface DriveSpace {
  space_id: string
  root_asset_id: string
  kind: string
}

/** 云盘独立读取当前账号的数据，离开页面时丢弃过期异步结果。 */
export function CloudLibrary() {
  const { t } = useI18n()
  const copy = t.cloudLibrary
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([])
  const [space, setSpace] = useState<DriveSpace | null>(null)
  const [items, setItems] = useState<DriveAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const [editing, setEditing] = useState<DriveAsset | 'new' | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const parent = folders.at(-1)?.id || space?.root_asset_id

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    void (async () => {
      try {
        const next = (await driveRequest<{ items: DriveSpace[] }>('/asset-spaces')).items.find(
          item => item.kind === 'personal'
        )

        if (!next) {
          throw new Error(copy.personal)
        }

        const params = new URLSearchParams({
          space_id: next.space_id,
          parent_asset_id: folders.at(-1)?.id || next.root_asset_id,
          page_no: '1',
          page_size: '100',
          sort: 'name_asc'
        })

        const result: DriveAsset[] = []

        for (let page = 1; ; page++) {
          params.set('page_no', String(page))
          const batch = await driveRequest<{ items: DriveAsset[]; page?: { has_more: boolean } }>(`/assets?${params}`)

          if (cancelled) {
            return
          }

          result.push(...batch.items)

          if (!batch.page?.has_more) {
            break
          }

          if (page >= 100) {
            throw new Error('云盘目录过大，请进入子目录查看')
          }
        }

        if (cancelled) {
          return
        }

        setSpace(next)
        setItems(result)
      } catch (failure) {
        if (!cancelled) {
          setItems([])
          setError(failure instanceof Error ? failure.message : copy.personal)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()

    return () => { cancelled = true }
  }, [folders, revision, copy.personal])

  /** 弹窗提交名称，成功后刷新权威列表。 */
  async function saveName() {
    if (!name.trim() || !editing || !parent) {
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
      setRevision(value => value + 1)
    } catch (failure) {
      notifyError(failure, copy.rename)
    } finally {
      setSaving(false)
    }
  }

  /** 用户确认后才移动到回收站。 */
  async function trash(asset: DriveAsset) {
    if (!(await confirm({ title: copy.trash, description: asset.name, destructive: true }))) {
      return
    }

    try {
      await driveRequest('/assets/trash', 'POST', {
        file_ids: asset.kind === 'file' ? [asset.asset_id] : [],
        directory_ids: asset.kind === 'directory' ? [asset.asset_id] : []
      })
      setRevision(value => value + 1)
    } catch (failure) {
      notifyError(failure, copy.trash)
    }
  }

  /** 文件交给既有预览浏览器，下载只由用户点击触发。 */
  async function open(asset: DriveAsset, download = false) {
    if (asset.kind === 'directory') {
      setFolders(value => [...value, { id: asset.asset_id, name: asset.name }])

      return
    }

    try {
      const url = await driveDownload(asset)

      if (download) {
        await window.hermesDesktop.openExternal(url)
      } else {
        openPreview({ kind: 'url', url, label: asset.name, source: 'cloud-drive', transient: true })
      }
    } catch (failure) {
      notifyError(failure, copy.preview)
    }
  }

  const visible = items.filter(item => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2">
        <Button onClick={() => setFolders([])} size="sm" variant="ghost">
          {copy.personal}
        </Button>
        {folders.map((folder, index) => (
          <Button
            key={folder.id}
            onClick={() => setFolders(value => value.slice(0, index + 1))}
            size="sm"
            variant="ghost"
          >
            / {folder.name}
          </Button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Input
            aria-label={copy.search}
            containerClassName="w-52 max-w-full"
            onChange={event => setQuery(event.target.value)}
            placeholder={copy.search}
            prefix={<Search />}
            value={query}
          />
          <Button
            disabled={!parent || loading}
            onClick={() => {
              setName('')
              setEditing('new')
            }}
            size="sm"
            variant="outline"
          >
            <Plus />
            {copy.createFolder}
          </Button>
          <Button
            aria-label={copy.refresh}
            disabled={loading}
            onClick={() => setRevision(value => value + 1)}
            size="icon-xs"
            variant="ghost"
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <PageLoader label={t.common.loading} />
        ) : error ? (
          <div role="alert">
            {error}
            <Button onClick={() => setRevision(value => value + 1)}>{copy.refresh}</Button>
          </div>
        ) : visible.length === 0 ? (
          <p>{t.catalog.noResults}</p>
        ) : (
          visible.map(asset => (
            <div className="flex items-center gap-2 border-b border-border/50 py-2 text-sm" key={asset.asset_id}>
              <Button className="min-w-0 flex-1 justify-start" onClick={() => void open(asset)} variant="ghost">
                <FolderOpen />
                <span className="truncate">{asset.name}</span>
              </Button>
              <Button
                aria-label={copy.rename}
                onClick={() => {
                  setName(asset.name)
                  setEditing(asset)
                }}
                size="icon-xs"
                variant="ghost"
              >
                <Pencil />
              </Button>
              <Button aria-label={copy.trash} onClick={() => void trash(asset)} size="icon-xs" variant="ghost">
                <Trash2 />
              </Button>
              {asset.kind === 'file' && (
                <Button
                  aria-label={copy.download}
                  onClick={() => void open(asset, true)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <Download />
                </Button>
              )}
            </div>
          ))
        )}
      </div>
      <Dialog
        onOpenChange={value => {
          if (!value && !saving) {
            setEditing(null)
          }
        }}
        open={editing !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? copy.createFolder : copy.rename}</DialogTitle>
          </DialogHeader>
          <Input
            aria-label={editing === 'new' ? copy.createFolder : copy.rename}
            disabled={saving}
            onChange={event => setName(event.target.value)}
            value={name}
          />
          <DialogFooter>
            <Button disabled={saving} onClick={() => setEditing(null)}>
              {t.common.cancel}
            </Button>
            <Button disabled={saving || !name.trim()} onClick={() => void saveName()}>
              {t.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
