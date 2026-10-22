import type { MessagingPlatformInfo, StatusResponse } from '@/types/hermes'

export function hasInheritedGatewayFailure(platform: MessagingPlatformInfo): boolean {
  return !platform.gateway_running && platform.state === 'startup_failed'
}

/** 整体 exit_reason 不能证明渠道归属；只恢复 /api/status 中按渠道 ID 保存的失败详情。 */
export function restorePlatformErrors(
  platforms: MessagingPlatformInfo[],
  status: Pick<StatusResponse, 'gateway_running' | 'gateway_state' | 'gateway_platforms'> | null
): MessagingPlatformInfo[] {
  const failures = status && !status.gateway_running && status.gateway_state === 'startup_failed'
    ? status.gateway_platforms : {}

  return platforms.map(platform => {
    if (!hasInheritedGatewayFailure(platform)) {
      return platform
    }

    const entry = failures[platform.id]
    const failure = entry?.state === 'fatal' ? entry : null

    return {
      ...platform,
      state: failure?.state ?? platform.state,
      error_code: failure?.error_code ?? null,
      error_message: failure?.error_message ?? null
    }
  })
}
