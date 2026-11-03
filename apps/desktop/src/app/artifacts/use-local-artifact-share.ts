import { supportsArtifactSharing } from '@/lib/browser-shell'
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { $apiRequestScope } from '@/api/client'
import { desktopFsCacheKey } from '@/lib/desktop-fs'
import { $connection } from '@/store/session'

import type { LocalArtifact } from './local-artifact-model'

/** 仅在操作入口可见时核对原生分享资格；来源和上下文变化立即隐藏旧入口。 */
export function useLocalArtifactShare(file: LocalArtifact, open: boolean, candidate: boolean): boolean {
  const connection = useStore($connection)
  const scope = useStore($apiRequestScope)
  const bridge = window.hermesDesktop
  const api = bridge?.artifactShare
  const connectionKey = desktopFsCacheKey(connection)

  const key = JSON.stringify([
    connectionKey,
    file.profile,
    file.sessionId,
    file.resolvedPath,
    file.byteSize,
    file.timestamp
  ])

  const [state, setState] = useState<{ key: string; scope: object; bridge: object; publishable: boolean } | null>(null)

  useEffect(() => {
    if (!candidate || !supportsArtifactSharing(connection) || !open || !api || !file.resolvedPath) {
      return
    }

    let active = true
    let generation = 0
    const path = file.resolvedPath
    setState(null)

    /** 每次原生分享状态变动后重新核对；迟到资格不能写入新菜单或新账号。 */
    function refresh(): void {
      const current = ++generation
      void api!
        .eligibility({ sessionId: file.sessionId, path })
        .then(result => {
          if (active && current === generation) {
            setState({ key, scope, bridge, publishable: result.publishable })
          }
        })
        .catch(() => {
          if (active && current === generation) {
            setState(null)
          }
        })
    }

    refresh()
    const unsubscribe = api.onChanged(refresh)

    return () => {
      active = false
      generation += 1
      unsubscribe()
    }
  }, [candidate, connection?.mode, open, api, file.resolvedPath, file.sessionId, key, scope, bridge, connectionKey])

  return !!(
    candidate &&
    supportsArtifactSharing(connection) &&
    api &&
    state?.bridge === bridge &&
    state.scope === scope &&
    state.key === key &&
    state.publishable
  )
}
