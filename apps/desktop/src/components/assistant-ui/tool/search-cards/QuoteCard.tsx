/**
 * Quote VR card — generic price/rate card for exchangerate + gold (quote style).
 *
 * 数据源: backend `_canonical_exchangerate()` / `_canonical_gold()` (quote style)
 * 注入到 `raw._canonical`. 两个 canonical schema 完全对齐 (都有 quotes: [{...}]
 * 结构), 所以 QuoteCard 同一份组件渲染两种 category.
 *
 * - exchangerate (70269501): 单一 quote (USD/CNY 等), 4 个 stats 段 (最高/最低/昨收/今开).
 * - gold quote (70227501): 1-2 个 quote (国内+国际), 每个 quote 自己的 4 stats.
 *
 * 视觉: 每个 quote 一行 (label + 大字 value + unit + 涨跌色), 下面跟当日 stats.
 */

import type { VRCardProps } from './types'

interface QuoteStat {
  label: string
  value?: string | null
  trend?: 'up' | 'down' | 'draw' | null
}

interface Quote {
  label?: string | null // exchangerate: null. gold: "国内价格(元/克)" 等
  value: string
  unit?: string | null
  trend?: 'up' | 'down' | 'draw' | null
  change_value?: string | null
  change_pct?: string | null
  stats?: QuoteStat[] | null
}

interface CanonicalQuote {
  name: string // pair (USD/CNY) 或 贵金属名称 (黄金)
  quotes: Quote[]
  source?: string | null
  updated?: string | null
  trade_status?: string | null
  url?: string | null
  // style 字段仅 gold 有 ("quote" / "merchant"); exchangerate 无.
  style?: string | null
}

/** 必需数据齐全时才渲染单卡，缺失时保留同次搜索的其他结果。 */
function getCanonical(raw: Record<string, unknown>): CanonicalQuote | null {
  const c = raw._canonical as CanonicalQuote | undefined

  if (!c || !c.name || !c.quotes || c.quotes.length === 0) {
    return null
  }

  // 至少一个 quote 有 value 才有渲染意义
  if (!c.quotes.some(q => q.value)) {
    return null
  }

  return c
}

/** 每个报价只展示自己的涨跌与统计数据。 */
function QuoteRow({ q }: { q: Quote }) {
  const trend: 'up' | 'down' | 'draw' = q.trend ?? 'draw'
  const arrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '—'
  const stats = q.stats ?? []

  return (
    <div className="vrcard-quote-row">
      {q.label && <div className="vrcard-quote-label">{q.label}</div>}
      <div className={`vrcard-stock-price vrcard-stock-${trend}`}>
        <span className="vrcard-stock-num">{q.value}</span>
        {q.unit && <span className="vrcard-quote-unit">{q.unit}</span>}
        {(q.change_value || q.change_pct) && (
          <span className="vrcard-stock-diff">
            {arrow} {q.change_value ?? ''}
            {q.change_pct ? ` ${q.change_pct}` : ''}
          </span>
        )}
      </div>
      {stats.length > 0 && (
        <div className="vrcard-stock-range">
          {stats.map((s, i) => (
            <span key={i}>
              {s.label} {s.value ?? '-'}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** 黄金行情与汇率复用同一报价结构，避免展示逻辑漂移。 */
export function QuoteCard({ card }: VRCardProps) {
  const c = getCanonical(card.raw)

  if (!c) {
    return null
  }

  return (
    <div className="vrcard vrcard-quote">
      <div className="vrcard-header">
        <span className="vrcard-title">{c.name}</span>
        {c.source && <span className="vrcard-tag">{c.source}</span>}
      </div>
      {c.quotes.map((q, i) => (
        <QuoteRow key={i} q={q} />
      ))}
    </div>
  )
}
