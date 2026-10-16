import { useStore } from '@nanostores/react'
import type { ComponentProps } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { WeixinRestartOutcome } from '@/api/weixin-qr'
import { PageLoader } from '@/components/page-loader'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorBanner } from '@/components/ui/error-state'
import { getMessagingPlatforms, type MessagingPlatformInfo, updateMessagingPlatform } from '@/hermes'
import { useI18n } from '@/i18n'
import { AlertTriangle, MessageCircle, RefreshCw } from '@/lib/icons'
import { $changeEventsAvailable, $platformsChangeTick } from '@/store/live-sync'
import { notify } from '@/store/notifications'
import { $settingsRequestProfile } from '@/store/settings-scope'
import { $gatewayRestarting, runGatewayRestart, watchGatewayRestartOutcome } from '@/store/system-actions'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { PAGE_INSET_X } from '../layout-constants'
import { PageSearchShell } from '../page-search-shell'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { CREDENTIAL_KEYS, PLATFORM_IDS, PlatformCard, type PlatformId } from './platform-card'
import { PlatformConfigDialog } from './platform-config-dialog'
import { WeixinQrSetup } from './weixin-qr-setup'

interface MessagingViewProps extends ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

/** 继续使用原有配置作用域；页面不展示 Profile 选择，作用域变化时清掉旧表单与轮询。 */
export function MessagingView({ setStatusbarItemGroup: _setStatusbarItemGroup, ...props }: MessagingViewProps) {
  const scopeProfile = useStore($settingsRequestProfile)

  return <MessagingPage key={scopeProfile ?? 'custom'} scopeProfile={scopeProfile} {...props} />
}

/** 卡片页面只组合现有接口，不介入账号启动、消息执行或网关生命周期。 */
function MessagingPage({ scopeProfile, ...props }: ComponentProps<'section'> & { scopeProfile: string | undefined }) {
  const { t } = useI18n()
  const m = t.messaging
  const [platforms, setPlatforms] = useState<MessagingPlatformInfo[] | null>(null)
  const [query, setQuery] = useState('')
  const [loadError, setLoadError] = useState(false)
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [configuring, setConfiguring] = useState<Exclude<PlatformId, 'weixin'> | null>(null)
  const [disconnecting, setDisconnecting] = useState<MessagingPlatformInfo | null>(null)
  const gatewayRestarting = useStore($gatewayRestarting)
  const changesAvailable = useStore($changeEventsAvailable)
  const platformsTick = useStore($platformsChangeTick)
  const revisionRef = useRef(0)
  const refreshTimer = useRef<number | null>(null)

  /** 只接收最后一轮读取结果；失败保留已有卡片，且不把旧状态当作刷新成功。 */
  const refresh = useCallback(async () => {
    const revision = ++revisionRef.current

    try {
      const result = await getMessagingPlatforms(scopeProfile)

      if (revision !== revisionRef.current) {
        return
      }

      setPlatforms(result.platforms.filter(platform => PLATFORM_IDS.includes(platform.id as PlatformId)))
      setLoadError(false)
    } catch {
      if (revision === revisionRef.current) {
        setLoadError(true)
      }
    }
  }, [scopeProfile])

  useRefreshHotkey(() => void refresh())

  // 清理函数只让旧请求失效，不把响应式值同步到 ref。
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    void refresh()

    /** 失去推送事件时沿用原页面的定时刷新，隐藏窗口不发起轮询。 */
    const tick = () => {
      if (!document.hidden && !changesAvailable) {
        void refresh()
      }
    }

    const interval = window.setInterval(tick, 6000)

    /** 回到页面时重新读取状态，不触发任何网关启动或重启。 */
    const visible = () => {
      if (!document.hidden) {
        void refresh()
      }
    }

    document.addEventListener('visibilitychange', visible)

    return () => {
      revisionRef.current += 1
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', visible)

      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current)
      }
    }
  }, [changesAvailable, refresh])

  useEffect(() => {
    if (platformsTick > 0 && !document.hidden) {
      void refresh()
    }
  }, [platformsTick, refresh])

  /** 保留原有重启后的延迟读取，不增加重复重启。 */
  function refreshAfterConnect() {
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current)
    }

    refreshTimer.current = window.setTimeout(() => void refresh(), 4000)
  }

  /** 原生热生效或重启提示保持原逻辑，第二阶段再处理连接联动。 */
  function settleUpdate(hotServed?: boolean) {
    if (hotServed) {
      refreshAfterConnect()
    } else {
      setRestartNeeded(true)
    }
  }

  /** 必要凭据与启用开关通过同一个既有接口保存，其它配置不写回。 */
  async function save(platform: MessagingPlatformInfo, env: Record<string, string>) {
    const result = await updateMessagingPlatform(platform.id, { env, enabled: true }, scopeProfile)
    await refresh()
    settleUpdate(result.hot_served)
    notify({
      kind: 'success',
      title: m.setupSaved(platform.name),
      message: result.hot_served ? m.connectingLive : m.restartToReconnect
    })
  }

  /** 只移除本平台的必要凭据并关闭它，保留白名单、群聊及其它平台配置。 */
  async function disconnect() {
    if (!disconnecting) {
      return
    }

    const id = disconnecting.id as Exclude<PlatformId, 'weixin'>

    const result = await updateMessagingPlatform(
      id,
      { enabled: false, clear_env: [...CREDENTIAL_KEYS[id]] },
      scopeProfile
    )

    await refresh()
    settleUpdate(result.hot_served)
  }

  /** 沿用原版手动网关重启，成功后再刷新；不自动恢复网关。 */
  async function restart() {
    if (await runGatewayRestart()) {
      setRestartNeeded(false)
      refreshAfterConnect()
    }
  }

  /** 微信仍由扫码插件保存和重启；这里仅跟踪结果并保留失败后的原生恢复入口。 */
  async function settleWeixin(result: WeixinRestartOutcome, name: string, unbound = false) {
    await refresh()

    if (result.restart_started) {
      notify({
        kind: 'success',
        title: unbound ? m.setupUpdated(name) : m.setupSaved(name),
        message: unbound ? m.weixinQr.unbound : m.weixinQr.savedRestarting
      })
      setRestartNeeded(false)

      if (!(await watchGatewayRestartOutcome())) {
        setRestartNeeded(true)
        notify({
          kind: 'error',
          title: m.restartFailedManual,
          message: m.restartFailedManualDetail,
          action: { label: m.restartAgain, onClick: () => void restart() },
          secondaryAction: {
            label: m.openLogs,
            onClick: () => void window.hermesDesktop?.revealLogs?.().catch(() => undefined)
          }
        })
      }

      await refresh()
    } else if (result.needs_restart) {
      await restart()
    }
  }

  const selected = platforms?.find(platform => platform.id === configuring)
  const search = query.trim().toLocaleLowerCase()

  return (
    <PageSearchShell {...props} onSearchChange={setQuery} searchPlaceholder={m.search} searchValue={query}>
      <div className={'h-full overflow-y-auto pb-8 pt-4 ' + PAGE_INSET_X}>
        <div className="mx-auto grid w-full max-w-3xl gap-4">
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <MessageCircle className="size-4 text-(--ui-text-tertiary)" />
              {m.cards.heading}
            </h2>
            <p className="text-xs leading-5 text-(--ui-text-tertiary)">{m.cards.description}</p>
          </header>
          {loadError && (
            <ErrorBanner>
              {m.loadFailed}{' '}
              <Button onClick={() => void refresh()} size="inline" variant="link">
                {t.common.retry}
              </Button>
            </ErrorBanner>
          )}
          {restartNeeded && (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>{m.restartNeeded}</span>
                <Button disabled={gatewayRestarting} onClick={() => void restart()} size="sm" variant="secondary">
                  <RefreshCw className={gatewayRestarting ? 'animate-spin' : undefined} />
                  {gatewayRestarting ? m.restarting : m.restartNow}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!platforms && !loadError ? (
            <PageLoader label={m.loading} />
          ) : (
            [...PLATFORM_IDS, 'uniagentgate' as const]
              .filter(
                id =>
                  !search || (m.cards.titles[id] + ' ' + m.cards.descriptions[id]).toLocaleLowerCase().includes(search)
              )
              .map(id => {
                const platform = platforms?.find(row => row.id === id)

                if (id === 'weixin' && platform) {
                  return (
                    <WeixinQrSetup
                      key={id}
                      onSaved={result => void settleWeixin(result, platform.name)}
                      onUnbound={result => void settleWeixin(result, platform.name, true)}
                      platform={platform}
                      scopeProfile={scopeProfile}
                    />
                  )
                }

                return (
                  <PlatformCard
                    actions={
                      id !== 'uniagentgate' && (
                        <>
                          <Button
                            disabled={!platform}
                            onClick={() => setConfiguring(id as Exclude<PlatformId, 'weixin'>)}
                            size="sm"
                            variant="outline"
                          >
                            {m.cards.configure}
                          </Button>
                          {platform?.configured && (
                            <Button onClick={() => setDisconnecting(platform)} size="sm" variant="outline">
                              {m.cards.unbind}
                            </Button>
                          )}
                        </>
                      )
                    }
                    id={id}
                    key={id}
                    platform={platform}
                  >
                    {platform?.error_message && <ErrorBanner className="mt-3">{platform.error_message}</ErrorBanner>}
                  </PlatformCard>
                )
              })
          )}
        </div>
      </div>
      {selected && (
        <PlatformConfigDialog
          key={selected.id}
          onClose={() => setConfiguring(null)}
          onSave={env => save(selected, env)}
          platform={selected}
        />
      )}
      <ConfirmDialog
        cancelLabel={t.common.cancel}
        confirmLabel={m.cards.unbind}
        description={m.cards.unbindDescription}
        destructive
        onClose={() => setDisconnecting(null)}
        onConfirm={disconnect}
        open={disconnecting !== null}
        title={m.cards.unbindTitle}
      />
    </PageSearchShell>
  )
}
