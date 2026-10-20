import { useStore } from '@nanostores/react'
import type { ComponentProps } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { WeixinRestartOutcome } from '@/api/weixin-qr'
import { PageLoader } from '@/components/page-loader'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorBanner } from '@/components/ui/error-state'
import { getMessagingPlatforms, type MessagingPlatformInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { AlertTriangle, CheckCircle2, Loader2, MessageCircle, RefreshCw } from '@/lib/icons'
import { confirm } from '@/store/confirm'
import { $platformsChangeTick } from '@/store/live-sync'
import { $settingsRequestProfile } from '@/store/settings-scope'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { PAGE_INSET_X } from '../layout-constants'
import { PageSearchShell } from '../page-search-shell'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { $messagingOperation } from './operation-store'
import { PLATFORM_IDS, PlatformCard, type PlatformId } from './platform-card'
import { PlatformConfigDialog } from './platform-config-dialog'
import { WeixinQrSetup } from './weixin-qr-setup'

interface MessagingViewProps extends ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

interface PlatformSnapshot {
  platforms: MessagingPlatformInfo[]
  operationRevision: number
}

/** 继续使用原有配置作用域；页面不展示 Profile 选择，作用域变化时清掉旧表单与轮询。 */
export function MessagingView({ setStatusbarItemGroup: _setStatusbarItemGroup, ...props }: MessagingViewProps) {
  const scopeProfile = useStore($settingsRequestProfile)

  return <MessagingPage key={scopeProfile ?? 'custom'} scopeProfile={scopeProfile} {...props} />
}

/** 页面提交必要配置，主进程统一校验保存和网关动作，原版接口提供连接状态。 */
function MessagingPage({ scopeProfile, ...props }: ComponentProps<'section'> & { scopeProfile: string | undefined }) {
  const { t } = useI18n()
  const m = t.messaging
  const [snapshot, setSnapshot] = useState<PlatformSnapshot | null>(null)
  const platforms = snapshot?.platforms ?? null
  const [query, setQuery] = useState('')
  const [loadError, setLoadError] = useState(false)
  const [requestFailed, setRequestFailed] = useState(false)
  const [configuring, setConfiguring] = useState<Exclude<PlatformId, 'weixin'> | null>(null)
  const [disconnecting, setDisconnecting] = useState<MessagingPlatformInfo | null>(null)
  const operation = useStore($messagingOperation)

  // 成功提示与卡片共用同一轮操作后的读取，不能先成功再显示旧的停机状态。
  const phase = operation.phase === 'completed' && snapshot?.operationRevision !== operation.revision
    ? 'checking' : operation.phase

  const applying = ['saving', 'applying', 'restarting', 'stopping', 'checking'].includes(phase)
  const gatewayChanging = ['restarting', 'stopping', 'checking'].includes(phase)
  const platformsTick = useStore($platformsChangeTick)
  const revisionRef = useRef(0)
  const activeRef = useRef(true)

  /** 只接收最后一轮读取结果；失败保留已有卡片，且不把旧状态当作刷新成功。 */
  const refresh = useCallback(async () => {
    if (!activeRef.current) {
      return
    }

    const revision = ++revisionRef.current
    const operationRevision = $messagingOperation.get().revision

    try {
      const result = await getMessagingPlatforms(scopeProfile)

      if (!activeRef.current || revision !== revisionRef.current) {
        return
      }

      setSnapshot({
        platforms: result.platforms.filter(platform => PLATFORM_IDS.includes(platform.id as PlatformId)),
        operationRevision
      })
      setLoadError(false)
    } catch {
      if (revision === revisionRef.current) {
        setLoadError(true)
      }
    }
  }, [scopeProfile])

  useRefreshHotkey(() => void refresh())
  // 仅记录组件是否仍存在，不镜像账号或响应式状态。
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    activeRef.current = true

    return () => {
      activeRef.current = false
    }
  }, [])

  // 清理函数只让旧请求失效，不把响应式值同步到 ref。
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    void refresh()

    /** 定时核对真实平台状态，隐藏窗口不发起轮询。 */
    const tick = () => {
      if (!document.hidden) {
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
    }
  }, [refresh])

  useEffect(() => {
    if (platformsTick > 0 && !document.hidden) {
      void refresh()
    }
  }, [platformsTick, refresh])

  // 任务由主进程继续；页面只在阶段变化后更新卡片，不参与任务生命周期。
  useEffect(() => {
    if (operation.revision > 0 && !document.hidden) {
      void refresh()
    }
  }, [operation.revision, refresh])

  /** 等待主进程接收后立即关闭配置框；凭据校验和重启进度在页面展示。 */
  async function save(platform: MessagingPlatformInfo, env: Record<string, string>) {
    setRequestFailed(false)

    try {
      const input = {
        operation: 'save' as const,
        platform: platform.id as Exclude<PlatformId, 'weixin'>,
        env,
        profile: scopeProfile
      }

      let result = await window.hermesDesktop.messagingSetup(input)

      if (!activeRef.current) {return false}

      if (result.confirmationRequired) {
        if (!(await confirm({ title: m.connection.duplicateTitle, description: m.connection.duplicateDescription }))) {return false}
        result = await window.hermesDesktop.messagingSetup({ ...input, confirmed: true })
      }

      return !!result.accepted
    } catch {
      throw new Error(m.connection.saveFailed)
    }
  }

  /** 解绑确认只等待任务接收，不等待清理配置或网关动作。 */
  async function disconnectPlatform(id: PlatformId) {
    setRequestFailed(false)

    try {
      await window.hermesDesktop.messagingSetup({ operation: 'disconnect', platform: id, profile: scopeProfile })
    } catch {
      throw new Error(m.connection.saveFailed)
    }
  }

  /** 复用已保存配置在后台重试，错误只留在消息页面。 */
  async function restart() {
    setRequestFailed(false)

    try {
      await window.hermesDesktop.messagingSetup({ operation: 'retry', profile: scopeProfile })
    } catch {
      if (activeRef.current) {setRequestFailed(true)}
    }
  }

  /** 微信已触发的重启只交给主进程跟踪，不再发起一次重启或全局通知。 */
  async function settleWeixin(result: WeixinRestartOutcome) {
    try {
      if (result.restart_started || result.needs_restart) {
        await window.hermesDesktop.messagingSetup({
          operation: result.restart_started ? 'watch' : 'retry', platform: 'weixin', profile: scopeProfile
        })
      }

      await refresh()
    } catch {
      if (activeRef.current) {setRequestFailed(true)}
    }
  }

  const errors: Record<string, string> = {
    credentials_rejected: m.connection.invalid,
    credentials_required: m.connection.invalid,
    secret_required_for_new_id: m.connection.newSecret,
    validation_network: m.connection.network,
    validation_timeout: m.connection.timeout,
    validation_response: m.connection.unavailable,
    validation_unavailable: m.connection.unavailable,
    bot_conflict: m.connection.duplicateDescription
  }

  const operationFailed = operation.phase === 'failed' || requestFailed
  const activePlatforms = platforms?.filter(platform => platform.enabled && platform.configured) ?? []

  const disconnected = !applying && activePlatforms.some(platform => !platform.gateway_running ||
    ['fatal', 'startup_failed', 'disconnected', 'stopped', 'pending_restart'].includes(platform.state ?? ''))

  const reconnecting = !applying && activePlatforms.some(platform => ['retrying', 'connecting'].includes(platform.state ?? ''))
  const failed = operationFailed || disconnected
  const progress = applying || (!failed && reconnecting)
  const recovery = operationFailed || disconnected || reconnecting

  const phaseMessages = {
    idle: '', saving: operation.operation === 'disconnect' ? m.weixinQr.unbinding : m.connection.saving,
    applying: operation.operation === 'restore' ? m.connection.restoring : m.connection.connecting,
    restarting: m.connection.restarting, stopping: m.connection.stopping,
    checking: m.connection.checking,
    completed: m.connection.applied,
    failed: operation.error === 'gateway_identity_unverified' ? m.connection.ownership
      : operation.operation === 'restore' ? m.connection.restoreFailed
      : operation.saved ? m.connection.savedFailed : errors[operation.error || ''] || m.connection.saveFailed
  }

  const message = requestFailed ? m.connection.savedFailed : operation.phase === 'failed' ? phaseMessages.failed
    : disconnected ? m.connection.disconnected : reconnecting ? m.connection.reconnecting : phaseMessages[phase]

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
          {message && (
            <Alert role="status" variant={failed ? 'warning' : progress ? 'default' : 'success'}>
              {failed ? <AlertTriangle /> : progress ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>{message}</span>
                {recovery && (operation.saved || requestFailed || disconnected || reconnecting) && (
                  <Button disabled={applying} onClick={() => void restart()} size="sm" variant="secondary">
                    <RefreshCw />{t.common.retry}
                  </Button>
                )}
                {recovery && (
                  <Button onClick={() => void window.hermesDesktop.revealLogs().catch(() => undefined)} size="sm" variant="secondary">
                    {m.openLogs}
                  </Button>
                )}
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
                      busy={applying}
                      key={id}
                      onSaved={result => void settleWeixin(result)}
                      onUnbind={() => disconnectPlatform('weixin')}
                      pending={gatewayChanging}
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
                            disabled={!platform || applying}
                            onClick={() => setConfiguring(id as Exclude<PlatformId, 'weixin'>)}
                            size="sm"
                            variant="outline"
                          >
                            {m.cards.configure}
                          </Button>
                          {platform?.configured && (
                            <Button
                              disabled={applying}
                              onClick={() => setDisconnecting(platform)}
                              size="sm"
                              variant="outline"
                            >
                              {m.cards.unbind}
                            </Button>
                          )}
                        </>
                      )
                    }
                    id={id}
                    key={id}
                    pending={gatewayChanging}
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
        dismissOnConfirm
        onClose={() => setDisconnecting(null)}
        onConfirm={() => disconnecting ? disconnectPlatform(disconnecting.id as PlatformId) : undefined}
        open={disconnecting !== null}
        title={m.cards.unbindTitle}
      />
    </PageSearchShell>
  )
}
