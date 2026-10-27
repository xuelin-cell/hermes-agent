import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { $apiRequestScope } from '@/api/client'
import { desktopFsCacheKey } from '@/lib/desktop-fs'
import { $connection } from '@/store/session'

import { artifactLibraryIdentity } from './local-artifact-platform'
import {
  cachedLocalArtifactGroups,
  listLocalArtifactSessions,
  type LocalArtifactCache,
  type LocalArtifactScan,
  scanLocalArtifacts
} from './local-artifact-scan'

// 只缓存当前账号窗口的元信息，关闭应用或替换账号桥后自动释放；不写文件内容或会话正文。
const windows = new WeakMap<object, Map<string, Map<string, LocalArtifactCache>>>()
const EMPTY: LocalArtifactScan = { groups: [], processed: 0, total: 0, failures: 0, scanning: false }

/** 账号桥、连接和 Profile 共同限定展示缓存，离页及重绑时丢弃迟到结果。 */
export function useLocalArtifacts() {
  const connection = useStore($connection)
  const scope = useStore($apiRequestScope)

  const [state, setState] = useState<{ bridge?: object; key: string; scan: LocalArtifactScan }>({
    key: '',
    scan: EMPTY
  })

  const [revision, setRevision] = useState(0)
  const busy = useRef(false)
  const bridge = window.hermesDesktop
  const connectionKey = desktopFsCacheKey(connection)

  const identity = artifactLibraryIdentity()

  const key = JSON.stringify([
    identity,
    scope.connectionId || connection?.connectionId || 'local',
    scope.profile || connection?.profile || 'default'
  ])

  let scopes = windows.get(bridge)

  if (!scopes) {
    scopes = new Map()
    windows.set(bridge, scopes)
  }

  let cache = scopes.get(key)

  if (!cache) {
    cache = new Map()
    scopes.set(key, cache)
  }

  const cached = cachedLocalArtifactGroups(cache)
  const scan = state.bridge === bridge && state.key === key ? state.scan : { ...EMPTY, groups: cached, scanning: true }

  // busy 是跨重渲染的请求互斥锁，不镜像任何 store 或响应式值。
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    let active = true
    busy.current = true
    const capturedScope = $apiRequestScope.get()

    /** 请求只可写回发起时的上下文，同名 Profile 往返也不能复活旧请求。 */
    const current = () =>
      active &&
      artifactLibraryIdentity() === identity &&
      window.hermesDesktop === bridge &&
      desktopFsCacheKey($connection.get()) === connectionKey &&
      $apiRequestScope.get() === capturedScope

    setState({ bridge, key, scan: { ...EMPTY, groups: cached, scanning: true } })

    void (async () => {
      try {
        const listed = await listLocalArtifactSessions(current)

        if (current()) {
          await scanLocalArtifacts(
            listed.sessions,
            cache,
            current,
            next => setState({ bridge, key, scan: next }),
            listed.failures
          )
        }
      } catch {
        if (current()) {
          setState({ bridge, key, scan: { ...EMPTY, groups: cached, failures: 1 } })
        }
      } finally {
        if (active) {
          busy.current = false
        }
      }
    })()

    return () => {
      active = false
      busy.current = false
    }
    // cached 是当前缓存的快照；只在上下文或显式刷新变化时开启新扫描。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, key, revision, connectionKey, scope])

  /** 同一轮扫描只允许一个刷新请求，避免重复读取历史消息。 */
  const refresh = useCallback(() => {
    if (!busy.current) {
      busy.current = true
      setRevision(value => value + 1)
    }
  }, [])

  return { ...scan, refresh }
}
