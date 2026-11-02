/**
 * VR card registry — dispatch by vr_category to specific React components.
 *
 * 当前已实现 5 类: weather / stock / exchangerate / gold / train.
 * 其它已知 vr_category (calendar / medical / baike / oil / phone / car / star)
 * 不在 registry → getCardComponent 返回 undefined → WebSearchResult 跳过渲染
 * 该卡 (LLM 文字回答里仍有结构化信息, 不丢内容).
 *
 * gold 比较特殊有 2 个 sub-style (quote / merchant), 走 GoldCard dispatcher
 * 内部根据 canonical.style 分流到 QuoteCard 或 GoldMerchantCard.
 *
 * 加新卡片类型: 在 cards/ 下新建 XxxCard.tsx, 然后在 REGISTRY 添加一行。
 */

import type { ComponentType } from 'react'

import { GoldCard } from './GoldCard'
import { QuoteCard } from './QuoteCard'
import { StockCard } from './StockCard'
import { TrainCard } from './TrainCard'
import type { VRCard, VRCardProps } from './types'
import { WeatherCard } from './WeatherCard'

const REGISTRY: Record<string, ComponentType<VRCardProps>> = {
  weather: WeatherCard,
  stock: StockCard,
  exchangerate: QuoteCard,
  gold: GoldCard, // dispatcher: quote → QuoteCard, merchant → GoldMerchantCard
  train: TrainCard
  // calendar / medical / baike / oil 后端 _render_* 文本给 LLM 即可,
  // 前端不做卡片 (视觉收益小 / 数据结构异质)
}

/** 仅分派明确支持的类型，未知或原型属性名不会成为组件。 */
export function getCardComponent(type: string): ComponentType<VRCardProps> | undefined {
  return Object.hasOwn(REGISTRY, type) ? REGISTRY[type] : undefined
}

export type { VRCard, VRCardProps }
