import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'

import { $apiRequestScope } from '@/api/client'
import { getMessagingPlatforms, getStatus } from '@/hermes'
import { queryClient } from '@/lib/query-client'
import { $platformsChangeTick } from '@/store/live-sync'
import { $connection } from '@/store/session'

import { $messagingOperation } from './operation-store'
import { DISPLAY_PLATFORM_IDS } from './platform-card'
import { hasInheritedGatewayFailure, restorePlatformErrors } from './platform-errors'

/** 账号切换会重启 Renderer；同进程缓存再按实际连接身份隔离，不保存凭据。 */
export function messagingScope(
  connection = $connection.get(),
  connectionId = $apiRequestScope.get().connectionId
): string {
  return JSON.stringify([
    connectionId,
    connection?.connectionId,
    connection?.baseUrl,
    connection?.remoteIdentity,
    connection?.mode
  ])
}

/** 缓存平台快照并合并读取；操作变更后补读，诊断仅在后台补充对应渠道的错误。 */
export function usePlatforms(
  scope: string,
  profile: string | undefined,
  operationRevision: number,
  platformsTick: number
) {
  const platformsQuery = useQuery(
    {
      queryKey: ['messaging-platforms', scope, profile],
      queryFn: async () => {
        // 操作发生变化时旧结果不能成为完成依据；复用同一请求队列补读最新状态。
        for (;;) {
          if (scope !== messagingScope()) {
            throw new Error('Messaging connection changed')
          }

          const revision = $messagingOperation.get().revision
          const tick = $platformsChangeTick.get()
          const result = await getMessagingPlatforms(profile)

          if (scope !== messagingScope()) {
            throw new Error('Messaging connection changed')
          }

          if (revision === $messagingOperation.get().revision && tick === $platformsChangeTick.get()) {
            return {
              platforms: result.platforms.filter(platform => DISPLAY_PLATFORM_IDS.some(id => id === platform.id)),
              operationRevision: revision
            }
          }
        }
      },
      retry: false,
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
      // 请求开始即清除轮询，完成后再计时；隐藏窗口由 Query 的可见性机制暂停轮询。
      refetchInterval: query => (query.state.fetchStatus === 'fetching' ? false : 6000)
    },
    queryClient
  )

  const snapshot = platformsQuery.data
  const stamp = `${platformsQuery.dataUpdatedAt}:${queryClient.getQueryState(['messaging-platforms', scope, profile])?.dataUpdateCount}`
  const fresh = platformsQuery.isFetchedAfterMount && !platformsQuery.isError
  const sameOperation = snapshot?.operationRevision === operationRevision
  const needsDiagnosis = fresh && sameOperation && snapshot?.platforms.some(hasInheritedGatewayFailure)

  const diagnosis = useQuery(
    {
      queryKey: ['messaging-diagnostics', scope, profile],
      queryFn: async () => {
        // 诊断失败仅缺少补充详情，不能拖住卡片，也不能把整体退出原因分配给某个渠道。
        const status = scope === messagingScope() ? await getStatus(profile).catch(() => null) : null

        return { stamp, status }
      },
      enabled: false,
      retry: false
    },
    queryClient
  )

  const { refetch } = platformsQuery
  const { refetch: diagnose, isFetching: diagnosing, data: diagnostic } = diagnosis

  // 不取消在途读取；查询函数会在操作或配置变化后补读。
  useEffect(() => {
    if (!document.hidden) {
      void refetch({ cancelRefetch: false })
    }
  }, [operationRevision, platformsTick, refetch])

  // 旧诊断完成后再补当前轮次，避免每次轮询都启动另一份慢诊断。
  useEffect(() => {
    if (needsDiagnosis && !diagnosing && diagnostic?.stamp !== stamp) {
      void diagnose({ cancelRefetch: false })
    }
  }, [needsDiagnosis, diagnosing, diagnostic?.stamp, stamp, diagnose])

  const platforms = useMemo(
    () =>
      snapshot
        ? restorePlatformErrors(
            snapshot.platforms,
            sameOperation && diagnostic?.stamp === stamp ? diagnostic.status : null
          )
        : null,
    [snapshot, diagnostic, stamp, sameOperation]
  )

  /** 手动刷新和操作完成刷新共享在途请求，不取消并重启慢请求。 */
  async function refresh() {
    await refetch({ cancelRefetch: false })
  }

  return {
    platforms,
    refresh,
    loadError: platformsQuery.isError,
    confirmedRevision: fresh ? snapshot?.operationRevision : undefined,
    snapshotRevision: snapshot?.operationRevision,
    checking: !fresh
  }
}
