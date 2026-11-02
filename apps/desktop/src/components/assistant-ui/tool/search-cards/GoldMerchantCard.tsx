import { cardText } from './labels'
/**
 * Gold merchant VR card — multi-brand price list (different visual from quote-style).
 *
 * 数据源: backend `_canonical_gold()` style="merchant" 分支 (vrid 70099201).
 * 跟 quote style 不同, 这个 variant 返回的是多家金店/银行的现货黄金价格列表,
 * 没有"主价格 + 涨跌幅"概念, 视觉用紧凑列表 + 分组 (金店 / 银行) 呈现。
 *
 * 视觉: 表头 "黄金价格 (多商家)" + 各 group (金店 / 银行) 内 brand + product + price 一行.
 */
import type { VRCardProps } from './types'

interface MerchantItem {
  brand: string
  product?: string | null
  price?: string | null
}

interface MerchantGroup {
  type?: string | null // "金店" / "银行" / null (无组 header)
  items: MerchantItem[]
}

interface CanonicalGoldMerchant {
  style: 'merchant'
  name: string
  merchant_groups: MerchantGroup[]
  source?: string | null
  updated?: string | null
  url?: string | null
}

/** 必需数据齐全时才渲染单卡，缺失时保留同次搜索的其他结果。 */
function getCanonical(raw: Record<string, unknown>): CanonicalGoldMerchant | null {
  const c = raw._canonical as CanonicalGoldMerchant | undefined

  if (!c || c.style !== 'merchant' || !c.merchant_groups || c.merchant_groups.length === 0) {
    return null
  }

  // 至少一组有 items
  if (!c.merchant_groups.some(g => g.items && g.items.length > 0)) {
    return null
  }

  return c
}

/** 多商家报价沿规范化分组展示，保持原有列表上限。 */
export function GoldMerchantCard({ card }: VRCardProps) {
  const c = getCanonical(card.raw)

  if (!c) {
    return null
  }

  return (
    <div className="vrcard vrcard-gold-merchant">
      <div className="vrcard-header">
        <span className="vrcard-title">
          {c.name} {cardText('price')}
        </span>
        <span className="vrcard-sub">{cardText('multipleMerchants')}</span>
        {c.updated && <span className="vrcard-tag">{c.updated}</span>}
      </div>
      {c.merchant_groups.map((g, gi) => (
        <div className="vrcard-merchant-group" key={gi}>
          {g.type && <div className="vrcard-merchant-group-type">{g.type}</div>}
          <div className="vrcard-merchant-list">
            {g.items.slice(0, 8).map((item, ii) => (
              <div className="vrcard-merchant-item" key={ii}>
                <span className="vrcard-merchant-brand">{item.brand}</span>
                {item.product && <span className="vrcard-merchant-product">{item.product}</span>}
                <span className="vrcard-merchant-price">{item.price ?? '-'}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
