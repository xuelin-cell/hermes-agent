import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from 'react-router'

import { $apiRequestScope } from '@/api/client'
import { useRefreshHotkey } from '@/app/hooks/use-refresh-hotkey'
import { openSessionFromPicker } from '@/app/open-session'
import { PanelEmpty } from '@/app/overlays/panel'
import { NEW_CHAT_ROUTE } from '@/app/routes'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useResizeObserver } from '@/hooks/use-resize-observer'
import { useI18n } from '@/i18n'
import { desktopFsCacheKey, revealDesktopPath } from '@/lib/desktop-fs'
import { ChevronDown, ChevronRight, RefreshCw, Star } from '@/lib/icons'
import { downloadGatewayMediaFile } from '@/lib/media'
import { fmtDayTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import { openPreview } from '@/store/preview'
import { $connection, setSessionOwnerHint } from '@/store/session'

import { ArtifactUploadDialog } from './artifact-upload'
import { addLocalArtifactDraft } from './local-artifact-draft'
import {
  filterLocalArtifacts,
  LOCAL_ARTIFACT_TYPES,
  type LocalArtifact,
  type LocalArtifactType,
  localFavoriteKey,
  localSessionKey,
  readLocalFavorites,
  withoutPublishedArtifactLinks,
  writeLocalFavorites
} from './local-artifact-model'
import { artifactFileResolver, artifactLibraryIdentity, usesInstanceArtifactLibrary } from './local-artifact-platform'
import { LocalArtifactRow } from './local-artifact-row'
import { useLocalArtifacts } from './use-local-artifacts'

/** 桌面和云端实例共用资料库交互，文件访问由各自的边界核验。 */
export function LocalArtifactLibrary() {
  const { t } = useI18n()
  const copy = t.localArtifacts
  const navigate = useNavigate()
  const cloud = usesInstanceArtifactLibrary()
  const identity = artifactLibraryIdentity()
  const connection = useStore($connection)
  const connectionKey = desktopFsCacheKey(connection)
  const scope = useStore($apiRequestScope)
  const data = useLocalArtifacts()
  const [query, setQuery] = useState('')
  const [type, setType] = useState<LocalArtifactType>('all')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [favorites, setFavorites] = useState(readLocalFavorites)
  const [closed, setClosed] = useState(new Set<string>())
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [groupLimit, setGroupLimit] = useState(50)
  const [share, setShare] = useState<LocalArtifact | null>(null)
  /** 分享对话框关闭使用稳定回调，避免重新启动文件读取。 */
  const closeShare = useCallback(() => setShare(null), [])
  const [upload, setUpload] = useState<LocalArtifact | null>(null)
  const [uploaded, setUploaded] = useState(new Set<string>())
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLElement>(null)
  const [wide, setWide] = useState(false)

  /** 只观察列表容器，侧栏或预览占用空间后同步切换操作布局。 */
  const measureActions = useCallback(
    (entries: readonly ResizeObserverEntry[]) => {
      const width = entries[0]?.contentRect.width

      if (width !== undefined && width > 672 !== wide) {
        // ResizeObserver 在绘制前回调；只在跨过断点时同步提交，避免先画出旧工具栏。
        flushSync(() => setWide(width > 672))
      }
    },
    [wide]
  )

  useResizeObserver(measureActions, listRef)
  const lifecycle = useRef({ active: true, generation: 0, busy: false })
  useRefreshHotkey(data.refresh, !upload && !share)
  useEffect(() => {
    const state = lifecycle.current
    state.active = true
    state.generation += 1
    setUpload(null)
    setShare(null)
    setFavorites(readLocalFavorites())
    setUploaded(new Set())
    setClosed(new Set())
    setLimits({})
    setBusy(false)
    state.busy = false

    return () => {
      state.active = false
      state.generation += 1
    }
  }, [connectionKey, scope, identity])
  useEffect(() => {
    setGroupLimit(50)
  }, [query, type, favoritesOnly])

  const artifactGroups = useMemo(() => withoutPublishedArtifactLinks(data.groups), [data.groups])

  const groups = useMemo(
    () => filterLocalArtifacts(artifactGroups, query, type, favoritesOnly, favorites),
    [artifactGroups, query, type, favoritesOnly, favorites]
  )

  const showProfiles = new Set(artifactGroups.map(group => group.session.profile || 'default')).size > 1
  const total = artifactGroups.reduce((count, group) => count + group.files.length, 0)

  /** 文件操作捕获原窗口及上下文，迟到结果不打开新页面或改变新草稿。 */
  async function act(file: LocalArtifact, operation: 'preview' | 'folder' | 'add'): Promise<void> {
    const state = lifecycle.current

    if (state.busy) {
      return
    }

    const generation = state.generation

    /** 窗口尺寸和日志更新不改变文件归属，真正切换来源才作废当前操作。 */
    const current = () =>
      artifactLibraryIdentity() === identity &&
      state.active &&
      state.generation === generation &&
      desktopFsCacheKey($connection.get()) === connectionKey &&
      $apiRequestScope.get() === scope

    state.busy = true
    setBusy(true)

    try {
      if (operation === 'add') {
        if (!(await addLocalArtifactDraft(file, current))) {
          throw new Error(copy.attachFailed)
        }

        // 成功后原生新会话意图会改变上下文，只由这次明确点击导航。
        if (state.active) {
          navigate(NEW_CHAT_ROUTE)
        }
      } else if (operation === 'folder' && cloud) {
        await downloadGatewayMediaFile(file.resolvedPath!, {
          sessionId: file.sessionId, profile: file.profile || 'default', suggestedName: file.label
        })
      } else if (operation === 'folder') {
        if (!file.resolvedPath || !window.hermesDesktop.revealPath) {
          throw new Error(copy.fileUnavailable)
        }

        await revealDesktopPath(file.resolvedPath)
      } else if (file.kind === 'link' || /^https?:\/\//i.test(file.value)) {
        if (current()) {
          await window.hermesDesktop.openExternal(file.href)
        }
      } else {
        const target = file.resolvedPath ? await artifactFileResolver()(file.resolvedPath) : null

        if (!target) {
          throw new Error(copy.fileUnavailable)
        }

        if (current()) {
          openPreview({
            ...target,
            shareOrigin: {
              connectionId: 'local',
              profile: file.profile || 'default',
              sessionId: file.sessionId,
              path: file.resolvedPath!
            }
          })
        }
      }
    } catch (error) {
      if (current()) {
        notifyError(error, operation === 'add' ? copy.attachFailed : t.artifacts.openFailed)
      }
    } finally {
      if (state.generation === generation) {
        state.busy = false

        if (state.active) {
          setBusy(false)
        }
      }
    }
  }

  /** 收藏更新不改变文件；持久化失败保留原状态并允许重试。 */
  function toggleFavorite(file: LocalArtifact): void {
    const key = localFavoriteKey(file)

    if (!key) {
      return
    }

    const next = readLocalFavorites()

    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
    }

    if (writeLocalFavorites(next)) {
      setFavorites(next)
    } else {
      notifyError(new Error(copy.favoriteFailed), copy.favoriteFailed)
    }
  }

  /** 查看来源通过 Hermes 统一入口，补齐跨 Profile 会话的精确归属。 */
  function openSource(file: LocalArtifact): void {
    setSessionOwnerHint(file.sessionId, { connectionId: 'local', profile: file.profile || 'default', mode: cloud ? 'remote' : 'local' })
    openSessionFromPicker(file.sessionId, navigate)
  }

  /** 折叠状态按来源会话保存，搜索过滤不会把同名会话合为一组。 */
  function toggleGroup(key: string): void {
    setClosed(previous => {
      const next = new Set(previous)

      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }

      return next
    })
  }

  return (
    <section className="flex h-full min-h-0 flex-col" ref={listRef}>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
        <Select onValueChange={value => setType(value as LocalArtifactType)} value={type}>
          <SelectTrigger aria-label={copy.filterType} className="w-28 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-(--radix-select-trigger-width) min-w-0">
            {LOCAL_ARTIFACT_TYPES.map(value => (
              <SelectItem key={value} value={value}>
                {copy.categories[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SearchField containerClassName="min-w-36 flex-1" onChange={setQuery} placeholder={copy.search} value={query} />
        <Button
          aria-pressed={favoritesOnly}
          onClick={() => setFavoritesOnly(value => !value)}
          size="sm"
          variant={favoritesOnly ? 'secondary' : 'ghost'}
        >
          <Star />
          {copy.myFavorites}
        </Button>
        <Button
          aria-label={t.artifacts.refresh}
          disabled={data.scanning}
          onClick={data.refresh}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCw className={cn(data.scanning && 'animate-spin')} />
        </Button>
      </div>
      <div
        aria-live="polite"
        className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-muted-foreground"
        role="status"
      >
        <span>{copy.total(artifactGroups.length, total)}</span>
        {data.scanning && <span>{copy.scanning(data.processed, data.total)}</span>}
      </div>
      {data.failures > 0 && (
        <div className="flex items-center gap-2 px-4 pb-2 text-xs text-muted-foreground" role="alert">
          {copy.partialLoad(data.failures)}
          <Button disabled={data.scanning} onClick={data.refresh} size="xs" variant="ghost">
            {t.common.retry}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {!groups.length &&
          (data.scanning && !total ? (
            <PageLoader label={copy.loading} />
          ) : (
            <PanelEmpty
              icon={favoritesOnly ? 'star' : 'file'}
              title={
                total ? (favoritesOnly && !query && type === 'all' ? copy.noFavorites : copy.noResults) : copy.empty
              }
            />
          ))}
        {groups.slice(0, groupLimit).map(group => {
          const key = localSessionKey(group.session)
          const collapsed = closed.has(key)
          const limit = limits[key] || 50
          const title = group.session.title || group.files[0]?.sessionTitle || copy.untitled

          return (
            <section className="mb-1" key={key}>
              <div className="flex min-h-8 items-center gap-2 text-sm">
                <Button
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? copy.expand(title) : copy.collapse(title)}
                  onClick={() => toggleGroup(key)}
                  size="icon-sm"
                  variant="ghost"
                >
                  {collapsed ? <ChevronRight /> : <ChevronDown />}
                </Button>
                <button
                  className="min-w-0 cursor-pointer truncate text-left font-normal focus-visible:outline-ring"
                  onClick={() => openSource(group.files[0])}
                  type="button"
                >
                  {title}
                </button>
                <span className="shrink-0 text-xs text-muted-foreground">{copy.fileCount(group.files.length)}</span>
                {group.session.archived && <span className="text-xs text-muted-foreground">{copy.archived}</span>}
                <span className="ml-auto hidden text-xs text-muted-foreground sm:block">
                  {showProfiles && <>{group.session.profile || 'default'} · </>}
                  {group.session.last_active ? fmtDayTime.format(new Date(group.session.last_active * 1000)) : ''}
                </span>
              </div>
              {!collapsed &&
                group.files
                  .slice(0, limit)
                  .map(file => (
                    <LocalArtifactRow
                      busy={busy}
                      canShare={
                        (file.profile || 'default') === (scope.profile || connection?.profile || 'default') &&
                        /\.(html?|mdx?|markdown)$/i.test(file.label)
                      }
                      download={cloud}
                      favorite={favorites.has(localFavoriteKey(file) || '')}
                      file={file}
                      key={file.id}
                      onAdd={() => void act(file, 'add')}
                      onFavorite={() => toggleFavorite(file)}
                      onFolder={() => void act(file, 'folder')}
                      onOpen={() => void act(file, 'preview')}
                      onShare={() => setShare(current => (current?.id === file.id ? null : file))}
                      onShareClose={closeShare}
                      onUpload={() => setUpload(file)}
                      shareOpen={share?.id === file.id}
                      uploaded={uploaded.has(`${file.id}:${file.byteSize}:${file.timestamp}`)}
                      wide={wide}
                    />
                  ))}
              {!collapsed && group.files.length > limit && (
                <Button onClick={() => setLimits(value => ({ ...value, [key]: limit + 50 }))} size="sm" variant="ghost">
                  {copy.showMore}
                </Button>
              )}
            </section>
          )
        })}
        {groups.length > groupLimit && (
          <Button onClick={() => setGroupLimit(value => value + 50)} size="sm" variant="ghost">
            {copy.showMore}
          </Button>
        )}
      </div>
      {upload && (
        <ArtifactUploadDialog
          artifact={upload}
          onClose={() => setUpload(null)}
          onUploaded={() =>
            setUploaded(previous => new Set(previous).add(`${upload.id}:${upload.byteSize}:${upload.timestamp}`))
          }
        />
      )}
    </section>
  )
}
