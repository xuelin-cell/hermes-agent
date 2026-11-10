import { useStore } from '@nanostores/react'
import type { ComponentProps } from 'react'
import { useEffect, useRef, useState } from 'react'

import { $apiRequestScope } from '@/api/client'
import type { WeixinRestartOutcome } from '@/api/weixin-qr'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorBanner } from '@/components/ui/error-state'
import type { MessagingPlatformInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { AlertTriangle, Loader2, MessageCircle, RefreshCw, X } from '@/lib/icons'
import { confirm } from '@/store/confirm'
import { $platformsChangeTick } from '@/store/live-sync'
import { notify } from '@/store/notifications'
import { $connection } from '@/store/session'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { PAGE_INSET_X } from '../layout-constants'
import { PageSearchShell } from '../page-search-shell'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { $dismissedMessagingFailureRevision, $messagingOperation } from './operation-store'
import { DISPLAY_PLATFORM_IDS, hasPlatformBinding, PLATFORM_IDS, PlatformCard, type PlatformId } from './platform-card'
import { PlatformConfigDialog } from './platform-config-dialog'
import { messagingScope, usePlatforms } from './use-platforms'
import { WeixinQrSetup } from './weixin-qr-setup'

interface MessagingViewProps extends ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

// 专家助手没有独立消息平台，网关只服务主助手；页面固定读写主助手，不跟随设置页当前编辑的助手。
const MESSAGING_PROFILE = 'default'

/** 消息平台只属于主助手：切到专家时也不会读到或写进专家复制来的旧凭据。 */
export function MessagingView({ setStatusbarItemGroup: _setStatusbarItemGroup, ...props }: MessagingViewProps) {
  const requestScope = useStore($apiRequestScope)
  const connection = useStore($connection)
  const scope = messagingScope(connection, requestScope.connectionId)

  return <MessagingPage key={scope} scope={scope} scopeProfile={MESSAGING_PROFILE} {...props} />
}

/** 页面提交必要配置，主进程统一校验保存和网关动作，原版接口提供连接状态。 */
function MessagingPage({ scope, scopeProfile, ...props }: ComponentProps<'section'> & { scope: string; scopeProfile: string | undefined }) {
  const { t } = useI18n()
  const m = t.messaging
  const [query, setQuery] = useState('')
  const [requestFailed, setRequestFailed] = useState(false)
  const [rcsReconnecting, setRcsReconnecting] = useState(false)
  const [configuring, setConfiguring] = useState<Exclude<PlatformId, 'weixin'> | null>(null)
  const [disconnecting, setDisconnecting] = useState<MessagingPlatformInfo | null>(null)
  const operation = useStore($messagingOperation)
  const platformsTick = useStore($platformsChangeTick)

  const { platforms, refresh, loadError, confirmedRevision, snapshotRevision, checking } = usePlatforms(
    scope, scopeProfile, operation.revision, platformsTick
  )

  const failureDismissed = useStore($dismissedMessagingFailureRevision) === operation.revision
  const enabledPlatforms = platforms?.filter(platform => platform.enabled) ?? []

  const target = platforms?.find(platform => platform.id === operation.platform)

  const targetRecovered = !operation.platform || !!target && (operation.operation === 'disconnect'
    ? !hasPlatformBinding(target) : target.enabled && target.configured && target.gateway_running && target.state === 'connected')

  const sameProfile = (operation.profile ?? 'default') === (scopeProfile ?? 'default')

  // 解绑只确认目标清理及网关动作；其它渠道的连接问题继续由各自状态展示。
  const connectionRecovered = operation.phase === 'failed' && operation.saved && targetRecovered &&
    operation.error === 'connection_timeout' && sameProfile &&
    !loadError && confirmedRevision === operation.revision &&
    (operation.operation === 'disconnect' && operation.platform
      ? enabledPlatforms.length > 0
        ? platforms?.some(platform => platform.gateway_running)
        : !!platforms?.length && platforms.every(platform => !platform.gateway_running)
      : enabledPlatforms.length > 0 && enabledPlatforms.every(platform =>
        platform.configured && platform.gateway_running && platform.state === 'connected'))

  // 刚进入页面时还没读到最新平台状态；历史上的连接超时只是旧记录，此时不能当结论展示，
  // 否则平台其实早已连上，也会先闪一下“连接失败”。读取失败时无法核对，仍按记录显示。
  const verifying = operation.phase === 'failed' && operation.error === 'connection_timeout' &&
    !loadError && confirmedRevision !== operation.revision

  // 同一操作的缓存返回时静默刷新；新操作完成后仍须新快照，不能用前一操作的状态确认。
  const phase = connectionRecovered || verifying ? 'idle'
    : operation.phase === 'completed' && snapshotRevision !== operation.revision
    ? 'checking' : operation.phase

  const applying = checking || ['saving', 'applying', 'restarting', 'stopping', 'checking'].includes(phase)
  const gatewayChanging = ['applying', 'restarting', 'stopping', 'checking'].includes(phase)
  const activeRef = useRef(true)

  useRefreshHotkey(() => void refresh())
  // 仅记录组件是否仍存在，不镜像账号或响应式状态。
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    activeRef.current = true

    return () => {
      activeRef.current = false
    }
  }, [])

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

  const activePlatforms = enabledPlatforms.filter(platform => platform.configured && PLATFORM_IDS.includes(platform.id as PlatformId))

  const disconnected = !applying && activePlatforms.some(platform => !platform.gateway_running ||
    ['fatal', 'startup_failed', 'disconnected', 'stopped', 'pending_restart'].includes(platform.state ?? ''))

  const reconnecting = !applying && activePlatforms.some(platform => ['retrying', 'connecting'].includes(platform.state ?? ''))

  // 启动恢复超时只是历史结果；当前账号的平台仍在按原版策略连接时，按“正在重连”展示，不当作失败。
  const slowRestore = phase === 'failed' && operation.operation === 'restore' &&
    operation.error === 'connection_timeout' && sameProfile && reconnecting

  const operationFailed = (phase === 'failed' && !slowRestore && !failureDismissed) || requestFailed
  const failed = operationFailed || disconnected
  const recovery = operationFailed || disconnected || reconnecting

  // 解绑失败分两种：绑定还在就是没解成；绑定已清、只是网关动作没完成，如实说明而不冒充整体成功。
  const unbindFailed = operation.saved && !(target && hasPlatformBinding(target))
    ? m.connection.unbindApplyFailed : m.connection.unbindFailed

  const phaseMessages = {
    idle: '', saving: operation.operation === 'disconnect' ? m.weixinQr.unbinding : m.connection.saving,
    applying: operation.operation === 'restore' ? m.connection.restoring : m.connection.connecting,
    restarting: m.connection.restarting, stopping: m.connection.stopping,
    checking: m.connection.checking,
    completed: '',
    failed: operation.error === 'gateway_identity_unverified' ? m.connection.ownership
      : operation.operation === 'restore' ? m.connection.restoreFailed
      : operation.operation === 'disconnect' ? unbindFailed
      : operation.saved ? m.connection.savedFailed : errors[operation.error || ''] || m.connection.saveFailed
  }

  const message = requestFailed ? m.connection.savedFailed
    : phase === 'failed' && !slowRestore && !failureDismissed ? phaseMessages.failed
    : disconnected ? m.connection.disconnected : reconnecting ? m.connection.reconnecting
    : phase === 'failed' ? '' : phaseMessages[phase]

  const selected = platforms?.find(platform => platform.id === configuring)

  /** 只请求当前账号的 5G 连接恢复，不用整网关重启代替单平台重连。 */
  async function reconnectRcs() {
    if (rcsReconnecting) {
      return
    }

    setRcsReconnecting(true)

    try {
      const result = await window.hermesDesktop?.reconnectUniAgentGate?.(scopeProfile)
      const status = result?.status ?? 'restart_required'

      const messages = {
        connected: m.cards.reconnected,
        connecting: m.connectingLive,
        busy: m.cards.reconnectBusy,
        unbound: m.cards.personalBindingMissing,
        failed: m.cards.reconnectFailed,
        unavailable: m.cards.reconnectFailed,
        stopped: m.cards.reconnectFailed,
        restart_required: m.cards.reconnectRestartRequired
      }

      notify({
        kind: status === 'connected' || status === 'connecting' ? 'success' : 'error',
        title: m.cards.titles.uniagentgate,
        message: messages[status]
      })
      await refresh()
    } catch {
      notify({ kind: 'error', title: m.cards.titles.uniagentgate, message: m.cards.reconnectFailed })
    } finally {
      setRcsReconnecting(false)
    }
  }

  const search = query.trim().toLocaleLowerCase()

  return (
    <PageSearchShell {...props} onSearchChange={setQuery} searchPlaceholder={m.search} searchValue={query}>
      <div className={'h-full overflow-y-auto pb-8 pt-4 ' + PAGE_INSET_X}>
        <div className="mx-auto grid w-full max-w-3xl gap-4">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="flex shrink-0 items-center gap-2 text-sm font-semibold leading-5">
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
            <Alert role="status" variant={failed ? 'warning' : 'default'}>
              {failed ? <AlertTriangle /> : <Loader2 className="animate-spin" />}
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
                {operationFailed && (
                  <Button aria-label={t.common.close} onClick={() => {
                    $dismissedMessagingFailureRevision.set(operation.revision)
                    setRequestFailed(false)
                  }} size="icon-sm" variant="ghost">
                    <X />
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}
          {DISPLAY_PLATFORM_IDS
            .filter(
              id =>
                !search || (m.cards.titles[id] + ' ' + m.cards.descriptions[id]).toLocaleLowerCase().includes(search)
            )
            .map(id => {
              const platform = platforms?.find(row => row.id === id)

              const retryAllowed = platform?.enabled && platform.configured &&
                (!platform.gateway_running || ['fatal', 'startup_failed', 'error', 'stopped', 'disconnected',
                  'pending_restart', 'retrying', 'connecting'].includes(platform.state ?? ''))

              const rcsRetryAllowed = platform?.configured && platform.enabled &&
                (!platform.gateway_running || ['fatal', 'startup_failed', 'error', 'stopped', 'disconnected', 'paused']
                  .includes(platform.state ?? ''))

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
                    id === 'uniagentgate' ? (
                      rcsRetryAllowed ? (
                        <Button disabled={applying || rcsReconnecting ||
                          (scopeProfile !== undefined && scopeProfile !== 'default')}
                          onClick={() => void reconnectRcs()} size="sm" variant="outline">
                          {rcsReconnecting ? m.cards.reconnecting : m.cards.reconnect}
                        </Button>
                      ) : (
                        <Button disabled size="sm" variant="outline">{m.cards.unbind}</Button>
                      )
                    ) : (
                      <>
                        {retryAllowed && (
                          <Button disabled={applying} onClick={() => void restart()} size="sm" variant="outline">
                            {t.common.retry}
                          </Button>
                        )}
                        <Button
                          disabled={!platform || applying}
                          onClick={() => setConfiguring(id as Exclude<PlatformId, 'weixin'>)}
                          size="sm"
                          variant="outline"
                        >
                          {m.cards.configure}
                        </Button>
                        {platform && hasPlatformBinding(platform) && (
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
                  checking={!platforms && !loadError}
                  id={id}
                  key={id}
                  pending={gatewayChanging}
                  platform={platform}
                >
                  {platform?.enabled && platform.error_message && <ErrorBanner className="mt-3">{platform.error_message}</ErrorBanner>}
                </PlatformCard>
              )
            })}
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
