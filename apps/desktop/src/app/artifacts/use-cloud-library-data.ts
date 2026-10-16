import { useEffect, useState } from 'react'

import { type DriveCapabilities, driveRequest, type DriveSpace, listDriveDirectory } from '@/api/drive'

import { claimCloudLibraryCache, readCloudLibraryCache } from './cloud-library-cache'
import { DriveDirectoryIndex, type DriveIndexSnapshot } from './drive-directory-index'

const EMPTY_INDEX: DriveIndexSnapshot = {
  items: [],
  scanning: false,
  complete: false,
  error: false,
  loadedDirectories: []
}

/** 先展示本账号窗口缓存，再启动页面独占扫描；离页取消订阅和定时器。 */
export function useCloudLibraryData() {
  const [cached] = useState(readCloudLibraryCache)
  const [index, setIndex] = useState<DriveDirectoryIndex | null>(null)
  const [snapshot, setSnapshot] = useState(cached?.snapshot ?? EMPTY_INDEX)
  const [space, setSpace] = useState<DriveSpace | null>(cached?.space ?? null)
  const [capabilities, setCapabilities] = useState<DriveCapabilities | null>(cached?.capabilities ?? null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    let owned: DriveDirectoryIndex | null = null
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    const previous = readCloudLibraryCache()
    const save = claimCloudLibraryCache()
    setError('')
    setIndex(null)
    setSpace(previous?.space ?? null)
    setCapabilities(previous?.capabilities ?? null)
    setSnapshot(previous?.snapshot ?? EMPTY_INDEX)

    void (async () => {
      try {
        let personal = previous?.space
        let caps = previous?.capabilities ?? null

        // 已连接的窗口复用空间信息，切页不必等待鉴权和能力请求才显示目录。
        if (!personal || !caps) {
          const [spaces, capabilities] = await Promise.all([
            driveRequest<{ items: DriveSpace[] }>('/asset-spaces'),
            driveRequest<DriveCapabilities>('/drive/capabilities').catch(() => null)
          ])

          personal = spaces.items.find(item => item.kind === 'personal')
          caps = capabilities
        }

        if (cancelled) {
          return
        }

        if (!personal?.space_id || !personal.root_asset_id) {
          throw new Error('Personal cloud drive unavailable')
        }

        const selectedSpace = personal

        const selectedCapabilities =
          caps &&
          ['create_folder', 'rename', 'trash', 'download'].every(
            key => typeof caps[key as keyof DriveCapabilities] === 'boolean'
          )
            ? caps
            : null

        const seed =
          previous?.space.space_id === personal.space_id && previous.space.root_asset_id === personal.root_asset_id
            ? previous.snapshot
            : undefined

        owned = new DriveDirectoryIndex(
          personal.root_asset_id,
          (parent, page) => listDriveDirectory(selectedSpace.space_id, parent, page),
          seed
        )
        unsubscribe = owned.subscribe(snapshot => {
          if (!cancelled) {
            setSnapshot(snapshot)
            save({
              space: selectedSpace,
              capabilities: selectedCapabilities,
              snapshot: { ...snapshot, scanning: false }
            })
          }
        })
        setSpace(selectedSpace)
        setCapabilities(selectedCapabilities)
        setSnapshot(owned.getSnapshot())
        setIndex(owned)
        void owned.sync(true)
        timer = setInterval(
          () => {
            if (owned && !owned.getSnapshot().scanning) {
              void owned.sync(true)
            }
          },
          5 * 60 * 1000
        )
      } catch (failure) {
        if (!cancelled) {
          if (previous) {
            setSnapshot({ ...previous.snapshot, scanning: false, error: true })
          } else {
            setError(failure instanceof Error ? failure.message : 'Cloud drive unavailable')
          }
        }
      }
    })()

    return () => {
      cancelled = true
      clearInterval(timer)
      unsubscribe?.()
      owned?.dispose()
    }
  }, [revision])

  /** 正常刷新复用本页索引；初始化失败时重新准备云盘连接。 */
  function refresh(): void {
    if (index && capabilities) {
      void index.sync(true)
    } else {
      setRevision(value => value + 1)
    }
  }

  /** 筛选切换复用正在进行的扫描，避免连续点击导致扫描不断重启。 */
  function refreshBackground(): void {
    if (!index?.getSnapshot().scanning) {
      refresh()
    }
  }

  return { snapshot, space, capabilities, error, refresh, refreshBackground }
}
