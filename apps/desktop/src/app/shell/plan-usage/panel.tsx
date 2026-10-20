import './style.css'

import { type ReactElement, useEffect, useState } from 'react'
import { Link } from 'react-router'

import planIcon from './icons/plan.svg?raw'
import usageIcon from './icons/usage.svg?raw'
import deadlineIcon from './icons/deadline.svg?raw'
import settingsIcon from './icons/settings.svg?raw'
import logoutIcon from './icons/logout.svg?raw'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/i18n'
import { isPlanUsageHidden } from '@/lib/browser-shell'
import { notify } from '@/store/notifications'

import type { LoginAccount } from '../../../../electron/login/contract'
import type { PlanUsage } from '../../../../electron/uniwork-usage/contract'

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
            {c.empty}
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
            <UsageMeter
              label={labels[window.name]}
              value={window.usedPercent}
              valueText={`${c.used} ${used}%`}
            />
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
              <strong className="plan-usage-quota-number">
                {formatTokenQuotaCompact(data.quota.used, locale)}
              </strong>
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

/** 侧栏套餐面板只在展开时刷新，关闭或账号切换后丢弃迟到响应，不落盘保存用量。 */
export function PlanUsagePanel({ account, trigger, onLogout }: PlanUsagePanelProps) {
  const { t, locale } = useI18n()
  const c = t.desktopLogin.planUsage
  const [open, setOpen] = useState(false)
  const [details, setDetails] = useState(false)
  const [refreshRequest, setRefreshRequest] = useState({ nonce: 0, force: false })
  const [data, setData] = useState<PlanUsage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<'auth' | 'failed' | 'restart' | null>(null)
  const [openingSource, setOpeningSource] = useState<'subscribe' | 'details' | null>(null)

  useEffect(() => {
    if (!open || isPlanUsageHidden()) {
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
      try {
        const bridge = force
          ? (window.hermesDesktop?.refreshPlanUsage ?? window.hermesDesktop?.getPlanUsage)
          : window.hermesDesktop?.getPlanUsage

        if (!bridge) {
          setData(null)
          setError('restart')
          if (force) {
            notify({ id: 'maas-plan-refresh-failed', kind: 'error', message: c.restart })
          }
          return
        }

        const result = await bridge()

        if (!live || request !== sequence) {
          return
        }

        if (
          result?.status === 'available' &&
          result.account.maskedPhone === account.maskedPhone &&
          result.account.expiresAt === account.expiresAt
        ) {
          setData(result.data)
          setError(null)
          if (force) {
            notify({ id: 'maas-plan-refreshed', kind: 'success', message: c.refreshed, placement: 'bottom-right' })
          }
        } else if (result?.status === 'available' || result?.reason === 'auth') {
          setData(null)
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
    /** 恢复焦点时重新查询，睡眠期间不制造后台轮询。 */
    function onFocus(): void {
      void refresh()
    }
    void refresh(refreshRequest.force)
    window.addEventListener('focus', onFocus)
    return () => {
      live = false
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [open, refreshRequest.nonce, refreshRequest.force, account.maskedPhone, account.expiresAt, c])

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
      : loading
        ? '—'
        : c.empty
  const expiryDate = formatPlanExpiryDate(data?.endTime, locale)
  const expirySummary = expiryDate
    ? data?.expired
      ? `${expiryDate} · ${c.expired}`
      : c.expiryText(expiryDate)
    : '—'
  const errorText = error
    ? error === 'restart'
      ? c.restart
      : error === 'auth'
        ? c.auth
        : data
          ? c.stale
          : c.failed
    : null
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
        variant="menu"
        className={trigger ? 'plan-usage-card account-card' : 'plan-usage-card'}
      >
        <section aria-label={c.title}>
          {trigger && (
            <>
              <div className="account-card-row account-card-plan" hidden={isPlanUsageHidden()}>
                <AccountIcon src={planIcon} />
                <span className="account-card-plan-name">
                  {data?.productName || (loading ? c.loading : c.unnamed)}
                </span>
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
                aria-expanded={details}
                className="account-card-row"
                hidden={isPlanUsageHidden()}
                onClick={() => setDetails(value => !value)}
                type="button"
              >
                <AccountIcon src={usageIcon} />
                <span>{c.actualUsage}</span>
                {!details && <span className="account-card-summary">{usageSummary}</span>}
                <Codicon
                  className="account-card-chevron"
                  name={details ? 'chevron-down' : 'chevron-right'}
                  size="0.875rem"
                />
              </button>
              {details && (
                <div className="account-card-expanded account-card-details-inline">
                  {data ? (
                    <UsageDetails action={detailsAction} data={data} showPlan={false} />
                  ) : (
                    <div className="plan-usage-summary">
                      <span className="plan-usage-details-action">{detailsAction}</span>
                    </div>
                  )}
                  {loading && !data && (
                    <p className="plan-usage-meta" role="status">
                      {c.loading}
                    </p>
                  )}
                  {errorText && (
                    <p className="plan-usage-error" role="status">
                      {errorText}
                    </p>
                  )}
                </div>
              )}
              <div className="account-card-row" hidden={isPlanUsageHidden()}>
                <AccountIcon src={deadlineIcon} />
                <span>{c.expires}</span>
                <span className="account-card-summary">{expirySummary}</span>
              </div>
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
                <Button
                  variant="text"
                  size="micro"
                  disabled={loading}
                  onClick={requestRefresh}
                  type="button"
                >
                  {c.refresh}
                </Button>
              </div>
              {data && <UsageDetails data={data} />}
            </div>
          )}
          {loading && !data && (!trigger || !details) && (
            <p role="status" className="plan-usage-meta">
              {c.loading}
            </p>
          )}
          {errorText && (!trigger || !details) && (
            <p role="status" className="plan-usage-error">
              {errorText}
            </p>
          )}
          {trigger && errorText && !details && (
            <Button
              variant="text"
              size="micro"
              disabled={loading}
              onClick={requestRefresh}
              type="button"
            >
              {c.refresh}
            </Button>
          )}
        </section>
      </PopoverContent>
    </Popover>
  )
}
