/**
 * Gold VR card dispatcher.
 *
 * 腾讯 gold 卡有 2 个视觉差异巨大的 sub-style, backend canonical 用 `style`
 * 字段区分, 本组件按 style dispatch:
 *
 * - `style: "merchant"` (70099201): 多商家黄金价格列表 → GoldMerchantCard
 * - `style: "quote"` (70227501): 单/双价格 + 涨跌 + 当日 stats → QuoteCard
 *   (跟 exchangerate 共用 QuoteCard, 因为 canonical shape 已对齐)
 *
 * 未知 style / 无 canonical → silent skip.
 */

import { GoldMerchantCard } from './GoldMerchantCard'
import { QuoteCard } from './QuoteCard'
import type { VRCardProps } from './types'

interface CanonicalWithStyle {
  style?: string
}

/** 按黄金卡片已校验的样式分派，未知内容不影响正文。 */
export function GoldCard(props: VRCardProps) {
  const c = props.card.raw._canonical as CanonicalWithStyle | undefined

  if (!c) {
    return null
  }

  if (c.style === 'merchant') {
    return <GoldMerchantCard {...props} />
  }

  // 默认走 quote (style="quote" 或老版本 canonical 没 style 字段时也兜底)
  return <QuoteCard {...props} />
}
