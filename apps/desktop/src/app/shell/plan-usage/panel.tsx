import './style.css'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/i18n'

import type { LoginAccount } from '../../../../electron/login/contract'
import type { PlanUsage } from '../../../../electron/uniwork-usage/contract'

/** 共享可访问进度条，数值来自主进程校验结果，颜色沿用当前主题。 */
function UsageMeter({ label, value }: { label: string; value: number }) {
  return (
    <div
      className="plan-usage-meter"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <span style={{ width: `${value}%` }} />
    </div>
  )
}

/** 只展示当前套餐对应的数据，缺失不冒充零用量，重置时间锚定上游查询时间。 */
function UsageDetails({ data }: { data: PlanUsage }) {
  const { t, locale } = useI18n()
  const c = t.desktopLogin.planUsage
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  const dates = new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
  const labels = { 'five-hour': c.fiveHour, week: c.week, month: c.month }
  const hasUsage = data.kind === 'coding_plan' ? data.windows.length > 0 : data.quota !== null
  return (
    <>
      <div className="plan-usage-product">
        <strong>{data.productName || c.unnamed}</strong>
        {data.expired && <span>{c.expired}</span>}
      </div>
      {data.endTime && (
        <p className="plan-usage-meta">
          {c.expires}：{data.endTime}
        </p>
      )}
      {!hasUsage && (
        <p role="status" className="plan-usage-meta">
          {c.empty}
        </p>
      )}
      {data.windows.map(window => (
        <div className="plan-usage-window" key={window.name}>
          <div className="plan-usage-summary">
            <span>{labels[window.name]}</span>
            <strong>
              {c.used} {number.format(window.usedPercent)}%
            </strong>
          </div>
          <UsageMeter label={labels[window.name]} value={window.usedPercent} />
          <p className="plan-usage-meta">
            {window.notStarted
              ? c.notStarted
              : window.resetAt === null
                ? '—'
                : window.resetAt <= Date.now()
                  ? c.resetDue
                  : `${c.reset}：${dates.format(window.resetAt)}`}
          </p>
        </div>
      ))}
      {data.quota && (
        <div className="plan-usage-window">
          <div className="plan-usage-summary">
            <span>{c.used}</span>
            <strong>{number.format(data.quota.usedPercent)}%</strong>
          </div>
          <UsageMeter label={c.used} value={data.quota.usedPercent} />
          <p className="plan-usage-meta">
            {number.format(data.quota.used)} / {number.format(data.quota.total)} {data.quota.unit ?? ''}
          </p>
          <p>
            {c.remaining}：{number.format(data.quota.remaining)} {data.quota.unit ?? ''}
          </p>
        </div>
      )}
      {data.concurrency && (
        <p className="plan-usage-meta">
          {c.concurrency}：{data.concurrency.current === null ? '—' : number.format(data.concurrency.current)} /{' '}
          {number.format(data.concurrency.limit)}
        </p>
      )}
    </>
  )
}

/** 侧栏套餐面板只在展开时刷新，关闭或账号切换后丢弃迟到响应，不落盘保存用量。 */
export function PlanUsagePanel({ account }: { account: LoginAccount }) {
  const { t } = useI18n()
  const c = t.desktopLogin.planUsage
  const [open, setOpen] = useState(false)
  const [retry, setRetry] = useState(0)
  const [data, setData] = useState<PlanUsage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<'auth' | 'failed' | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    let sequence = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    /** 主进程身份与当前显示账号同时匹配才接收结果，失败保留同账号的上次结果。 */
    async function refresh(): Promise<void> {
      const request = ++sequence
      clearTimeout(timer)
      setLoading(true)
      try {
        const result = await window.hermesDesktop?.getPlanUsage?.()
        if (!live || request !== sequence) return
        if (
          result?.status === 'available' &&
          result.account.maskedPhone === account.maskedPhone &&
          result.account.expiresAt === account.expiresAt
        ) {
          setData(result.data)
          setError(null)
        } else if (result?.status === 'available' || result?.reason === 'auth') {
          setData(null)
          setError('auth')
        } else setError('failed')
      } catch {
        if (live && request === sequence) setError('failed')
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
    void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      live = false
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [open, retry, account.maskedPhone, account.expiresAt])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button className="w-full justify-start" size="sm" variant="ghost" type="button">
          <Codicon name="dashboard" size="1rem" />
          <span>{c.title}</span>
          <Codicon className="ml-auto" name="chevron-right" size="0.875rem" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" variant="menu" className="plan-usage-card">
        <section aria-label={c.title}>
          <div className="plan-usage-heading">
            <h3>{c.title}</h3>
            <Button
              variant="text"
              size="micro"
              disabled={loading}
              onClick={() => setRetry(value => value + 1)}
              type="button"
            >
              {c.refresh}
            </Button>
          </div>
          {data && <UsageDetails data={data} />}
          {loading && !data && (
            <p role="status" className="plan-usage-meta">
              {c.loading}
            </p>
          )}
          {error && (
            <p role="status" className="plan-usage-error">
              {error === 'auth' ? c.auth : data ? c.stale : c.failed}
            </p>
          )}
        </section>
      </PopoverContent>
    </Popover>
  )
}
