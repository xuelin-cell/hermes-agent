import './style.css'

import { type ReactElement, useEffect, useState } from 'react'
import { Link } from 'react-router'

import planIcon from './icons/plan.svg?raw'
import usageIcon from './icons/usage.svg?raw'
import deadlineIcon from './icons/deadline.svg?raw'
import settingsIcon from './icons/settings.svg?raw'
import updateIcon from './icons/update.svg?raw'
import logoutIcon from './icons/logout.svg?raw'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { OverflowTip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { DESKTOP_CONFIG_REFRESHED_EVENT, NTFY_PLAN_REFRESHED_EVENT } from '@/lib/ntfy-instructions'
import { notify } from '@/store/notifications'
import { requestUpdateCheck } from '@/store/update-check'

import type { LoginAccount } from '../../../../electron/login/contract'
import type { PlanUsage, PlanUsageSnapshot } from '../../../../electron/uniwork-usage/contract'

import {
  formatPlanExpiryDate,
  formatTokenQuotaCompact,
  formatTokenQuotaExact,
  formatTokenQuotaPercent,
  formatUsagePercentage,
  formatUsageResetTime
} from './format'

/** 直接渲染随包编译的可信 SVG，避免 file 协议下外部遮罩加载失败；不接收远端 SVG。 */
function AccountIcon({ src }: { src: string }) {
  return <span aria-hidden="true" className="account-card-icon" dangerouslySetInnerHTML={{ __html: src }} />
}

interface PlanUsagePanelProps {
  account: LoginAccount
  trigger?: ReactElement
  onLogout?: () => void
}

/** 共享可访问进度条，数值来自主进程校验结果，颜色沿用当前主题。 */
function UsageMeter({ label, value, valueText }: { label: string; value: number; valueText?: string }) {
  return (
    <div
      className="plan-usage-meter"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={valueText}
    >
      <span style={{ width: `${value}%` }} />
    </div>
  )
}

interface UsageDetailsProps {
  data: PlanUsage
  showPlan?: boolean
  action?: ReactElement
}

/** 只展示当前套餐对应的数据，缺失不冒充零用量，重置时间锚定上游查询时间。 */
function UsageDetails({ data, showPlan = true, action }: UsageDetailsProps) {
  const { t, locale } = useI18n()
  const c = t.desktopLogin.planUsage
  const now = Date.now()
  const expiry = formatPlanExpiryDate(data.endTime, locale)
  const labels = { 'five-hour': c.fiveHour, week: c.week, month: c.month }
  const hasUsage = data.kind === 'coding_plan' ? data.windows.length > 0 : data.quota !== null
  const detailsAction = action && <span className="plan-usage-details-action">{action}</span>
  const unit = data.quota?.unit ?? ''
  const exact = data.quota
    ? c.tokenExact(
        formatTokenQuotaExact(data.quota.remaining, locale),
        formatTokenQuotaExact(data.quota.used, locale),
        formatTokenQuotaExact(data.quota.total, locale),
        unit
      )
    : ''
  return (
    <>
      {showPlan && (
        <>
          <div className="plan-usage-product">
            <strong>{data.productName || c.unnamed}</strong>
            {data.expired && <span>{c.expired}</span>}
          </div>
          <p className="plan-usage-meta">
            {c.expires}：{expiry ?? '—'}
          </p>
        </>
      )}
      {!hasUsage && (
        <div className="plan-usage-summary">
          <p role="status" className="plan-usage-meta">
            —
          </p>
          {detailsAction}
        </div>
      )}
      {data.windows.map((window, index) => {
        const used = formatUsagePercentage(window.usedPercent, locale)
        return (
          <div className="plan-usage-window" key={window.name}>
            <div className="plan-usage-summary">
              <span>{labels[window.name]}</span>
              <strong>
                {c.used} {used}%
              </strong>
              {index === 0 && detailsAction}
            </div>
            <UsageMeter label={labels[window.name]} value={window.usedPercent} valueText={`${c.used} ${used}%`} />
            <p className="plan-usage-meta">
              {window.notStarted
                ? c.notStarted
                : window.resetAt === null
                  ? '—'
                  : window.resetAt <= now
                    ? c.resetDue
                    : c.resetsAt(formatUsageResetTime(window.resetAt, now, locale))}
            </p>
          </div>
        )
      })}
      {data.quota && (
        <div className="plan-usage-window">
          <div className="plan-usage-summary plan-usage-token-summary">
            <span>{c.tokenUsed}</span>
            <strong>{formatTokenQuotaPercent(data.quota.usedPercent, locale)}%</strong>
            {detailsAction}
          </div>
          <UsageMeter label={exact} value={data.quota.usedPercent} valueText={exact} />
          <div className="plan-usage-quota" title={exact}>
            <span>
              <strong className="plan-usage-quota-number">{formatTokenQuotaCompact(data.quota.used, locale)}</strong>
              <span className="plan-usage-quota-separator"> / </span>
              <span className="plan-usage-quota-total">
                {formatTokenQuotaCompact(data.quota.total, locale)} {unit}
              </span>
            </span>
            <span className="plan-usage-quota-remaining">
              {c.remaining}：
              <strong className="plan-usage-quota-number">
                {formatTokenQuotaCompact(data.quota.remaining, locale)}
              </strong>{' '}
              {unit}
            </span>
          </div>
        </div>
      )}
    </>
  )
}

function matchesAccount(snapshot: PlanUsageSnapshot, maskedPhone: string, expiresAt: number): boolean {
  return snapshot.account.maskedPhone === maskedPhone && snapshot.account.expiresAt === expiresAt
}

/** 侧栏套餐面板只在展开时刷新，关闭或账号切换后丢弃迟到响应，不落盘保存用量。 */
export function PlanUsagePanel({ account, trigger, onLogout }: PlanUsagePanelProps) {
  const { t, locale } = useI18n()
  const c = t.desktopLogin.planUsage
  const { maskedPhone, expiresAt } = account
  const [open, setOpen] = useState(false)
  const [details, setDetails] = useState(false)
  const [refreshRequest, setRefreshRequest] = useState({ nonce: 0, force: false })
  const [snapshot, setSnapshot] = useState<PlanUsageSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<'auth' | 'failed' | 'restart' | null>(null)
  const [openingSource, setOpeningSource] = useState<'subscribe' | 'details' | null>(null)
  const data = snapshot && matchesAccount(snapshot, maskedPhone, expiresAt) ? snapshot.data : null

  useEffect(() => {
    if (!open) {
      return
    }
    let live = true
    let sequence = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    /** 主进程身份与当前显示账号同时匹配才接收结果，失败保留同账号的上次结果。 */
    async function refresh(force = false): Promise<void> {
      const request = ++sequence
      clearTimeout(timer)
      setLoading(true)
      setError(null)
      try {
        const manualRefresh = force ? window.hermesDesktop?.refreshPlanUsage : undefined
        const bridge = manualRefresh ?? window.hermesDesktop?.getPlanUsage

        if (!bridge) {
          setSnapshot(null)
          setError('restart')
          if (force) {
            notify({ id: 'maas-plan-refresh-failed', kind: 'error', message: c.restart })
          }
          return
        }

        const readCache = window.hermesDesktop?.getCachedPlanUsage

        if (readCache) {
          const cached = await readCache().catch(() => undefined)

          if (!live || request !== sequence) {
            return
          }

          if (cached !== undefined) {
            setSnapshot(cached && matchesAccount(cached, maskedPhone, expiresAt) ? cached : null)
          }
        }

        const result = await bridge()

        if (manualRefresh && result?.status === 'available' && matchesAccount(result, maskedPhone, expiresAt)) {
          window.dispatchEvent(new Event(DESKTOP_CONFIG_REFRESHED_EVENT))
        }

        if (!live || request !== sequence) {
          return
        }

        if (result?.status === 'available' && matchesAccount(result, maskedPhone, expiresAt)) {
          setSnapshot(result)
          setError(null)
          if (force) {
            notify({ id: 'maas-plan-refreshed', kind: 'success', message: c.refreshed, placement: 'bottom-right' })
          }
        } else if (result?.status === 'available' || result?.reason === 'auth') {
          setSnapshot(null)
          setError('auth')
          if (force) {
            notify({ id: 'maas-plan-refresh-failed', kind: 'error', message: c.auth })
          }
        } else {
          setError('failed')
          if (force) {
            notify({ id: 'maas-plan-refresh-failed', kind: 'error', message: c.refreshFailed })
          }
        }
      } catch {
        if (live && request === sequence) {
          setError('failed')
          if (force) {
            notify({ id: 'maas-plan-refresh-failed', kind: 'error', message: c.refreshFailed })
          }
        }
      } finally {
        if (live && request === sequence) {
          setLoading(false)
          timer = setTimeout(() => void refresh(), 60_000)
        }
      }
    }
    /** ntfy 已更新主进程缓存，和恢复焦点一样走普通读取。 */
    function reloadUsage(): void {
      void refresh()
    }

    void refresh(refreshRequest.force)
    window.addEventListener('focus', reloadUsage)
    window.addEventListener(NTFY_PLAN_REFRESHED_EVENT, reloadUsage)

    return () => {
      live = false
      clearTimeout(timer)
      window.removeEventListener('focus', reloadUsage)
      window.removeEventListener(NTFY_PLAN_REFRESHED_EVENT, reloadUsage)
    }
  }, [open, refreshRequest.nonce, refreshRequest.force, maskedPhone, expiresAt, c])

  /** 手动刷新绕过主进程 30 秒缓存；定时与聚焦仍走常规查询。 */
  function requestRefresh(): void {
    setRefreshRequest(value => ({ nonce: value.nonce + 1, force: true }))
  }

  /** 关闭后清除强制标记，下次打开仍按 30 秒缓存查询。 */
  function onOpenChange(next: boolean): void {
    setOpen(next)
    if (!next) {
      setRefreshRequest(value => (value.force ? { ...value, force: false } : value))
    }
  }

  /** 订阅只读取主进程身份；失败只提示分类结果，不回传 URL、手机号或 ticket。 */
  async function subscribe(source: 'subscribe' | 'details'): Promise<void> {
    if (openingSource) {
      return
    }

    setOpeningSource(source)

    try {
      if (!window.hermesDesktop?.subscribeMaasPlan) {
        notify({ id: 'maas-plan-subscribe', kind: 'error', message: c.subscribeRestart })
        return
      }

      const result = await window.hermesDesktop.subscribeMaasPlan()

      if (result?.status === 'opened') {
        return
      }

      notify({
        id: 'maas-plan-subscribe',
        kind: 'error',
        message:
          result?.reason === 'missing-phone'
            ? c.subscribeMissingPhone
            : result?.reason === 'auth'
              ? c.subscribeAuth
              : c.subscribeFailed
      })
    } catch {
      notify({ id: 'maas-plan-subscribe', kind: 'error', message: c.subscribeFailed })
    } finally {
      setOpeningSource(null)
    }
  }

  const planLabels = { 'five-hour': c.fiveHour, week: c.week, month: c.month }
  const usageSummary = data?.quota
    ? `${c.tokenUsed} ${formatTokenQuotaPercent(data.quota.usedPercent, locale)}%`
    : data?.kind === 'coding_plan' && data.windows.length
      ? `${c.used} ${formatUsagePercentage(data.windows[0].usedPercent, locale)}% · ${planLabels[data.windows[0].name]}`
      : null
  const detailsDisabled = usageSummary === null
  const detailsExpanded = details && !detailsDisabled
  const expiryDate = formatPlanExpiryDate(data?.endTime, locale)
  const expirySummary = expiryDate ? (data?.expired ? `${expiryDate} · ${c.expired}` : c.expiryText(expiryDate)) : '—'
  const errorText = error
    ? error === 'restart'
      ? c.restart
      : error === 'auth'
        ? c.auth
        : c.failed
    : null
  const statusMessage = errorText ?? (!trigger && loading && !data ? c.loading : null)
  const statusNotice = statusMessage && (
    <p
      className={`${errorText ? 'plan-usage-error' : 'plan-usage-meta'}${trigger ? ' account-card-status' : ''}`}
      role="status"
    >
      {statusMessage}
    </p>
  )
  const detailsAction = (
    <Button
      aria-busy={openingSource === 'details'}
      className="account-card-details"
      disabled={openingSource === 'details'}
      onClick={() => void subscribe('details')}
      size="compact"
      type="button"
      variant="ghost"
    >
      {c.details}
      <Codicon
        name={openingSource === 'details' ? 'loading' : 'link-external'}
        size="0.75rem"
        spinning={openingSource === 'details'}
      />
    </Button>
  )

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button className="w-full justify-start" size="sm" variant="ghost" type="button">
            <Codicon name="dashboard" size="1rem" />
            <span>{c.title}</span>
            <Codicon className="ml-auto" name="chevron-right" size="0.875rem" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={6}
        variant="menu"
        className={trigger ? 'plan-usage-card account-card' : 'plan-usage-card'}
      >
        <section aria-label={c.title}>
          {trigger && (
            <>
              <div className="account-card-row account-card-plan">
                <AccountIcon src={planIcon} />
                <OverflowTip label={data?.productName} placement="row">
                  <span className="account-card-plan-name">
                    {data?.productName || (!data && loading ? c.loading : c.unnamed)}
                  </span>
                </OverflowTip>
                <button
                  aria-label={c.refreshPlan}
                  className="account-card-refresh"
                  disabled={loading}
                  onClick={requestRefresh}
                  title={c.refreshPlan}
                  type="button"
                >
                  <Codicon className={loading ? 'animate-spin' : undefined} name="refresh" size="0.875rem" />
                </button>
                <button
                  aria-busy={openingSource === 'subscribe'}
                  className="account-card-subscribe"
                  disabled={openingSource === 'subscribe'}
                  onClick={() => void subscribe('subscribe')}
                  type="button"
                >
                  {openingSource === 'subscribe' ? c.subscribeBusy : c.subscribe}
                </button>
              </div>
              <button
                aria-expanded={detailsExpanded}
                className="account-card-row"
                disabled={detailsDisabled}
                onClick={() => setDetails(value => !value)}
                type="button"
              >
                <AccountIcon src={usageIcon} />
                <span>{c.actualUsage}</span>
                {!detailsExpanded && <span className="account-card-summary">{usageSummary ?? '—'}</span>}
                {!detailsDisabled && (
                  <Codicon
                    className="account-card-chevron"
                    name={detailsExpanded ? 'chevron-down' : 'chevron-right'}
                    size="0.875rem"
                  />
                )}
              </button>
              {detailsExpanded && data && (
                <div className="account-card-expanded account-card-details-inline">
                  <UsageDetails action={detailsAction} data={data} showPlan={false} />
                </div>
              )}
              <div className="account-card-row">
                <AccountIcon src={deadlineIcon} />
                <span>{c.expires}</span>
                <span className="account-card-summary">{expirySummary}</span>
              </div>
              {statusNotice}
              <div className="account-card-divider" />
              <button
                type="button"
                className="account-card-row account-card-update"
                onClick={() => {
                  setOpen(false)
                  void requestUpdateCheck()
                }}
              >
                <AccountIcon src={updateIcon} />
                <span>{t.updates.checkForUpdates}</span>
              </button>
              <Link className="account-card-row" to="/settings" onClick={() => setOpen(false)}>
                <AccountIcon src={settingsIcon} />
                <span>{t.commandCenter.nav.settings.title}</span>
              </Link>
              <div className="account-card-divider" />
              <button
                type="button"
                className="account-card-row account-card-logout"
                onClick={() => {
                  setOpen(false)
                  onLogout?.()
                }}
              >
                <AccountIcon src={logoutIcon} />
                <span>{c.logout}</span>
              </button>
            </>
          )}
          {!trigger && (
            <div className="account-card-expanded">
              <div className="plan-usage-heading">
                <h3>{c.title}</h3>
                <Button variant="text" size="micro" disabled={loading} onClick={requestRefresh} type="button">
                  {c.refresh}
                </Button>
              </div>
              {data && <UsageDetails data={data} />}
            </div>
          )}
          {!trigger && statusNotice}
        </section>
      </PopoverContent>
    </Popover>
  )
}
