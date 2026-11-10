import './enterprise-usage-mt.css'

/**
 * desktop-mt: 企业版左下角的额度（平台 39 号第 1 节）。照企业桌面端的 EnterpriseUsage：
 *
 * - EnterpriseUsageSummary：常驻在账号名下面的一行（maas-account-status.tsx 的账号按钮里），挂着时负责刷新；
 * - EnterpriseUsageDetails：点开账号卡片后顶部的各级明细（plan-usage/panel.tsx），「企业订阅积分」是企业用量，
 *   「个人额度」是个人用量。
 *
 * 数据和刷新在 lib/enterprise-usage-mt.ts。个人版、桌面版没有 getEnterpriseUsage，两处都不显示。
 */
import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import {
  $enterpriseUsage,
  cycleText,
  enterpriseUsageSupported,
  levelPercent,
  levelText,
  levelTone,
  refreshEnterpriseUsage,
  usageSummary,
  watchEnterpriseUsage
} from '@/lib/enterprise-usage-mt'

function UsageBar({ label, percent }: { label?: string; percent: number }) {
  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(percent)}
      className="enterprise-usage-bar"
      role={label ? 'progressbar' : undefined}
    >
      <span style={{ width: `${percent}%` }} />
    </span>
  )
}

/** 账号名下面那一行：用完了标红；有上限时写还剩多少，带进度条（80% 变黄）；都不限时写本周期已用。 */
export function EnterpriseUsageSummary() {
  const supported = enterpriseUsageSupported()
  const summary = usageSummary(useStore($enterpriseUsage))

  useEffect(() => (supported ? watchEnterpriseUsage() : undefined), [supported])

  if (!supported || !summary) {
    return null
  }

  return (
    <span className="enterprise-usage-summary" data-tone={summary.tone}>
      {summary.percent !== null && <UsageBar percent={summary.percent} />}
      <span className="enterprise-usage-caption">{summary.text}</span>
    </span>
  )
}

/** 账号卡片顶部：每一级一行（名称、已用 / 上限、进度条），底部写周期。 */
export function EnterpriseUsageDetails() {
  const supported = enterpriseUsageSupported()
  const usage = useStore($enterpriseUsage)

  useEffect(() => {
    if (supported) {
      void refreshEnterpriseUsage() // 点开就重新取一次
    }
  }, [supported])

  if (!supported || !usage || (!usage.available && !usage.error)) {
    return null
  }

  const levels = usage.levels ?? []
  const exhausted = usage.exceeded || levels.some(level => levelTone(level) === 'over')
  const cycle = cycleText(usage)

  return (
    <>
      <section aria-label="额度" className="enterprise-usage-details">
        {usage.available ? (
          <>
            {levels.map(level => (
              <div className="enterprise-usage-level" data-tone={levelTone(level)} key={`${level.level}:${level.label}`}>
                <div className="enterprise-usage-level-row">
                  <span>{level.label}</span>
                  <span className="enterprise-usage-level-value">{levelText(level)}</span>
                </div>
                {level.limit > 0 && <UsageBar label={level.label} percent={levelPercent(level)} />}
              </div>
            ))}
            {(cycle || usage.endsAt) && (
              <p className="enterprise-usage-foot">
                {[cycle, usage.endsAt ? `订阅到期 ${usage.endsAt.slice(0, 10)}` : ''].filter(Boolean).join(' · ')}
              </p>
            )}
            {exhausted && (
              <p className="enterprise-usage-warning" role="status">
                额度用完后不能再使用模型，请联系企业管理员调整额度。
              </p>
            )}
          </>
        ) : (
          <p className="enterprise-usage-foot" role="status">
            {usage.error}
          </p>
        )}
      </section>
      <div className="account-card-divider" />
    </>
  )
}
