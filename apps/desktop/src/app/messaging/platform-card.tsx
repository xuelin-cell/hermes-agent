import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { MessagingPlatformInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { CheckCircle2, Loader2 } from '@/lib/icons'

export const PLATFORM_IDS = ['weixin', 'dingtalk', 'feishu', 'wecom'] as const
export type PlatformId = (typeof PLATFORM_IDS)[number]

export const CREDENTIAL_KEYS: Record<Exclude<PlatformId, 'weixin'>, readonly string[]> = {
  dingtalk: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'],
  feishu: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
  wecom: ['WECOM_BOT_ID', 'WECOM_SECRET']
}

const GUIDES: Record<PlatformId, string> = {
  weixin: 'https://docs.qq.com/aio/DZkhpemVoTGNmVXJR',
  dingtalk: 'https://docs.qq.com/aio/DZmJuVGNjaWd5RnhK',
  feishu: 'https://docs.qq.com/aio/DZm1hV2tEb3JBaE5y',
  wecom: 'https://docs.qq.com/aio/DZkdEVW1CcG9VUFZa'
}

/** 状态来自现有接口；有凭据不代表网关或消息平台已经连接。 */
export function PlatformStatus({ platform, pending = false }: { platform?: MessagingPlatformInfo; pending?: boolean }) {
  const { t } = useI18n()
  const m = t.messaging

  const state = !platform
    ? 'unknown'
    : pending && platform.enabled && platform.configured
      ? 'connecting'
    : !platform.enabled
      ? 'disabled'
      : !platform.gateway_running
        ? 'gateway_stopped'
        : platform.state || 'unknown'

  const connected = state === 'connected'
  const failed = state === 'fatal' || state === 'startup_failed'
  const connecting = state === 'connecting' || state === 'retrying'

  return (
    <Badge role="status" variant={connected ? 'success' : failed ? 'destructive' : connecting ? 'warn' : 'muted'}>
      {connected && <CheckCircle2 />}
      {connecting && <Loader2 className="animate-spin" />}
      {platform && !platform.configured ? m.cards.notConnected : m.states[state] || m.unknown}
    </Badge>
  )
}

/** 消息平台的统一卡片；5G 仅展示待接入状态，不发起任何业务请求。 */
export function PlatformCard({
  id,
  platform,
  actions,
  pending: connectionPending,
  children
}: {
  id: PlatformId | 'uniagentgate'
  platform?: MessagingPlatformInfo
  actions?: ReactNode
  pending?: boolean
  children?: ReactNode
}) {
  const { t } = useI18n()
  const copy = t.messaging.cards
  const pending = id === 'uniagentgate'

  return (
    <article
      aria-label={copy.titles[id]}
      className="rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-card) p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold leading-5">{copy.titles[id]}</h3>
            {id === 'weixin' && <Badge>{t.messaging.recommended}</Badge>}
            {pending ? <Badge variant="muted">{copy.comingSoon}</Badge> : <PlatformStatus pending={connectionPending} platform={platform} />}
          </div>
          <p className="mt-1 text-xs leading-5 text-(--ui-text-tertiary)">{copy.descriptions[id]}</p>
          {!pending && (
            <Button className="mt-1" onClick={() => openExternalLink(GUIDES[id])} size="inline" variant="link">
              {copy.guide}
            </Button>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {pending ? (
            <Button disabled size="sm" variant="outline">
              {copy.configure}
            </Button>
          ) : (
            actions
          )}
        </div>
      </div>
      {children}
    </article>
  )
}
