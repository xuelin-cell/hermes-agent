import { cardText } from './labels'
/**
 * Stock VR card — price + up/down color + intraday range.
 *
 * 数据源: backend `_canonical_stock()` 注入到 `raw._canonical` 的统一 schema.
 * 当前 active variants (70280301 A股 / 70280302 + 70280305 港股) 字段一致, 一个
 * canonical 全 cover. 未来腾讯加新 variant 时, backend 给出 _canonical 即可,
 * 本组件不动 (or 走 silent skip 直到 backend canonical 接好新字段).
 *
 * 视觉: 大字股价 + 涨跌色 (红涨绿跌, 中国习惯) + 当日区间.
 */
import type { VRCardProps } from './types'

interface CanonicalStock {
  name: string
  code?: string | null
  code_prefix?: string | null // sh / sz / hk
  market?: string | null // A股 / 港股 / 美股
  price: string
  change_value?: string | null
  change_pct?: string | null
  trend?: 'up' | 'down' | 'draw' | null
  trade_status?: string | null
  updated?: string | null
  open?: string | null
  prev_close?: string | null
  high?: string | null
  low?: string | null
  volume?: string | null
  pe_ttm?: string | null
  market_cap?: string | null
  url?: string | null
}

/** 必需数据齐全时才渲染单卡，缺失时保留同次搜索的其他结果。 */
function getCanonical(raw: Record<string, unknown>): CanonicalStock | null {
  const c = raw._canonical as CanonicalStock | undefined

  // 必需字段: name + price. 缺则不渲染整张卡 (LLM 文字答案仍有数据).
  if (!c || !c.name || !c.price) {
    return null
  }

  return c
}

/** 展示同源的股价、涨跌及当日区间，不改变搜索过程展示。 */
export function StockCard({ card }: VRCardProps) {
  const c = getCanonical(card.raw)

  if (!c) {
    return null
  }

  const trend: 'up' | 'down' | 'draw' = c.trend ?? 'draw'
  const arrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '—'

  return (
    <div className="vrcard vrcard-stock">
      <div className="vrcard-header">
        <span className="vrcard-title">{c.name}</span>
        {c.code && <span className="vrcard-sub">{c.code}</span>}
        {c.market && <span className="vrcard-tag">{c.market}</span>}
      </div>
      <div className={`vrcard-stock-price vrcard-stock-${trend}`}>
        <span className="vrcard-stock-num">{c.price}</span>
        {(c.change_value || c.change_pct) && (
          <span className="vrcard-stock-diff">
            {arrow} {c.change_value ?? ''}
            {c.change_pct ? ` (${c.change_pct}%)` : ''}
          </span>
        )}
      </div>
      <div className="vrcard-stock-range">
        {c.open && (
          <span>
            {cardText('open')} {c.open}
          </span>
        )}
        {c.high && (
          <span>
            {cardText('high')} {c.high}
          </span>
        )}
        {c.low && (
          <span>
            {cardText('low')} {c.low}
          </span>
        )}
        {c.prev_close && (
          <span>
            {cardText('previousClose')} {c.prev_close}
          </span>
        )}
        {c.updated && <span className="vrcard-stock-time">{c.updated}</span>}
      </div>
    </div>
  )
}
