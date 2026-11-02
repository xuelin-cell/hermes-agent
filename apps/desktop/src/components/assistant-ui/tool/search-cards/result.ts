import { decodeWebResult } from './provider'

import { getCardComponent, type VRCard } from './index'

/** 只接受普通数据对象，避免把数组或空值当作卡片字段集合。 */
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** 所有会进入文字节点或字符串操作的可选字段都必须符合文本契约。 */
function textFields(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => row[key] == null || typeof row[key] === 'string')
}

/** 必需文字缺失时跳过单卡，保留同次搜索的其他结果与正文。 */
function requiredText(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => typeof row[key] === 'string' && !!row[key])
}

/** 校验当前与预报的完整显示字段，防止异常天气值传入字符串方法。 */
function weatherDay(value: unknown, required = false): boolean {
  const day = record(value)

  return (
    !!day &&
    textFields(day, [
      'date',
      'week',
      'summary',
      'temp_low',
      'temp_high',
      'wind',
      'humidity',
      'aqi',
      'forbidden',
      'temp_feel'
    ]) &&
    (!required || requiredText(day, ['summary', 'temp_low', 'temp_high']))
  )
}

/** 兼容原有旧天气结构，同时拒绝空元素及错误类型，避免历史恢复触发异常。 */
function legacyWeather(raw: Record<string, unknown>): boolean {
  const info = record(record(raw.jsonData)?.display_info)
  const days = info?.day

  return (
    !!info &&
    textFields(info, ['location']) &&
    Array.isArray(days) &&
    days.length > 0 &&
    days.every(value => {
      const day = record(value)

      return (
        !!day &&
        textFields(day, [
          'date',
          'other_week',
          'summary',
          'description_day',
          'description_night',
          'number_low',
          'number_high',
          'type_wind',
          'type_windlevel',
          'humidity',
          'forbidden'
        ]) &&
        requiredText(day, ['number_low', 'number_high']) &&
        ((typeof day.summary === 'string' && !!day.summary) ||
          (typeof day.description_day === 'string' && !!day.description_day))
      )
    })
  )
}

/** 报价行及其统计项必须逐项校验，不能只检查外层数组。 */
function validQuotes(c: Record<string, unknown>): boolean {
  return (
    requiredText(c, ['name']) &&
    textFields(c, ['source', 'updated', 'trade_status', 'url', 'style']) &&
    Array.isArray(c.quotes) &&
    c.quotes.every(value => {
      const row = record(value)

      return (
        !!row &&
        requiredText(row, ['value']) &&
        textFields(row, ['label', 'unit', 'trend', 'change_value', 'change_pct']) &&
        (row.stats == null ||
          (Array.isArray(row.stats) &&
            row.stats.every(value => {
              const stat = record(value)

              return !!stat && requiredText(stat, ['label']) && textFields(stat, ['value', 'trend'])
            })))
      )
    })
  )
}

/** 多商家报价的分组与商品都按实际渲染字段检查。 */
function validMerchants(c: Record<string, unknown>): boolean {
  return (
    requiredText(c, ['name']) &&
    textFields(c, ['source', 'updated', 'url']) &&
    Array.isArray(c.merchant_groups) &&
    c.merchant_groups.every(value => {
      const group = record(value)

      return (
        !!group &&
        textFields(group, ['type']) &&
        Array.isArray(group.items) &&
        group.items.every(value => {
          const item = record(value)

          return !!item && requiredText(item, ['brand']) && textFields(item, ['product', 'price'])
        })
      )
    })
  )
}

/** 火车类型会参与字符串判断；经停数组也必须保证每个元素可安全渲染。 */
function validTrains(c: Record<string, unknown>): boolean {
  return (
    textFields(c, ['updated', 'url']) &&
    Array.isArray(c.trains) &&
    c.trains.every(value => {
      const train = record(value)

      return (
        !!train &&
        requiredText(train, ['number']) &&
        textFields(train, [
          'from_station',
          'to_station',
          'type',
          'depart_time',
          'arrive_time',
          'duration',
          'price',
          'ticket_type'
        ]) &&
        (train.stops_count == null || (typeof train.stops_count === 'number' && Number.isFinite(train.stops_count))) &&
        (train.stops == null ||
          (Array.isArray(train.stops) &&
            train.stops.every(value => {
              const stop = record(value)

              return !!stop && requiredText(stop, ['name']) && textFields(stop, ['arrive', 'depart', 'stay'])
            })))
      )
    })
  )
}

const validators: Record<string, (c: Record<string, unknown>) => boolean> = {
  weather: c =>
    textFields(c, ['location', 'source', 'updated']) &&
    weatherDay(c.today, true) &&
    (c.forecast === undefined || (Array.isArray(c.forecast) && c.forecast.every(value => weatherDay(value)))),
  stock: c =>
    requiredText(c, ['name', 'price']) &&
    textFields(c, [
      'code',
      'code_prefix',
      'market',
      'change_value',
      'change_pct',
      'trend',
      'trade_status',
      'updated',
      'open',
      'prev_close',
      'high',
      'low',
      'volume',
      'pe_ttm',
      'market_cap',
      'url'
    ]),
  exchangerate: validQuotes,
  gold: c => (c.style === 'merchant' ? validMerchants(c) : validQuotes(c)),
  train: validTrains
}

/** 实时结果与历史 JSON 走同一校验，异常单卡不会进入聊天渲染树。 */
export function searchCards(result: unknown): VRCard[] {
  const body = decodeWebResult(result)
  const cards = record(body?.data)?.cards

  if (!body || body.success === false || !Array.isArray(cards)) {
    return []
  }

  return cards.filter((value): value is VRCard => {
    const card = record(value)
    const raw = record(card?.raw)

    if (!card || typeof card.type !== 'string' || !getCardComponent(card.type) || !raw) {
      return false
    }

    const canonical = record(raw._canonical)

    return canonical ? validators[card.type]?.(canonical) === true : card.type === 'weather' && legacyWeather(raw)
  })
}
