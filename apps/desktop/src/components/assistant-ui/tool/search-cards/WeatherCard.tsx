import { cardText } from './labels'
/**
 * Weather VR card — universal renderer across all Tencent variants.
 *
 * Data flow: backend `_canonical_weather()` 已经把任意 variant 数据 normalize 成
 * 统一 schema 塞进 `raw._canonical`。本组件优先读这个, 老路径 (jsonData.display_info.day)
 * 作 fallback 兼容历史数据。
 *
 * 必需字段 (缺则不渲染整张卡): today.summary + today.temp_low + today.temp_high.
 * 可选字段 (variant 没有就 silent skip): wind / humidity / aqi / forbidden / temp_feel.
 *
 * 视觉: 大字温度 + emoji + 当日小字 extra + 多日 forecast 列表。
 * 同一组件适配国内丰满版 (含 AQI / 限行) 和国际精简版 (仅温度+概要)。
 */
import type { VRCardProps } from './types'

interface CanonicalToday {
  date?: string
  week?: string
  summary?: string
  temp_low?: string
  temp_high?: string
  wind?: string
  humidity?: string
  aqi?: string
  forbidden?: string
  temp_feel?: string
}

interface CanonicalForecast {
  date?: string
  week?: string
  summary?: string
  temp_low?: string
  temp_high?: string
  wind?: string
}

interface CanonicalWeather {
  location?: string
  today: CanonicalToday
  forecast?: CanonicalForecast[]
  source?: string
  updated?: string
}

// ── Legacy schema (raw.jsonData.display_info.day[]) fallback ──────────
//
// 老 variant (vrid 702698**, 国内) 直接给 day 数组。如果 backend canonical
// 解析失败 / 老版本 backend 没塞 _canonical, 我们仍然能从老路径渲染。

interface LegacyDay {
  date?: string
  other_week?: string
  summary?: string
  description_day?: string
  description_night?: string
  number_low?: string
  number_high?: string
  type_wind?: string
  type_windlevel?: string
  humidity?: string
  time_sunrise?: string
  time_sunset?: string
  forbidden?: string
}

/** 历史天气数据继续映射到相同展示结构，兼容已保存的会话。 */
function legacyToCanonical(raw: Record<string, unknown>): CanonicalWeather | null {
  // 国内 path
  const jsonData = (raw.jsonData ?? {}) as Record<string, unknown>

  const info = (jsonData.display_info ?? {}) as {
    location?: string
    day?: LegacyDay[]
  }

  let days: LegacyDay[] = info.day ?? []
  let location = info.location

  // 国际 path fallback
  if (days.length === 0) {
    const display = (raw.display ?? {}) as Record<string, unknown>
    const subitem = (display.subitem ?? {}) as Record<string, unknown>
    const subdisplay = (subitem.subdisplay ?? {}) as Record<string, unknown>
    const intlDays = subdisplay.day as Record<string, unknown>[] | undefined

    if (intlDays && intlDays.length > 0) {
      days = intlDays.map(d => ({
        date: d.date as string | undefined,
        other_week: d.week as string | undefined,
        summary: d.description as string | undefined,
        number_low: d.low as string | undefined,
        number_high: d.high as string | undefined,
        type_wind: d.wind as string | undefined,
        type_windlevel: d.wind1 as string | undefined
      }))
      const key = subitem.key

      if (typeof key === 'string' && key) {
        location = key.replace('_', ' ')
      }
    }
  }

  if (days.length === 0) {
    return null
  }

  const today = days[0]
  const summary = today.summary || today.description_day

  if (!summary || !today.number_low || !today.number_high) {
    return null
  }

  /** 组合可用风向与风力，保持旧天气字段的展示兼容。 */
  const wind = (d: LegacyDay): string | undefined => {
    const parts = [d.type_wind, d.type_windlevel].filter(Boolean)

    return parts.length > 0 ? parts.join(' ') : undefined
  }

  return {
    location,
    today: {
      date: today.date,
      week: today.other_week,
      summary,
      temp_low: today.number_low,
      temp_high: today.number_high,
      wind: wind(today),
      humidity: today.humidity ? `${today.humidity}%` : undefined,
      forbidden: today.forbidden && today.forbidden !== '不限号' ? today.forbidden : undefined
    },
    forecast: days.slice(1, 8).map(d => ({
      date: d.date,
      week: d.other_week,
      summary: d.summary || d.description_day,
      temp_low: d.number_low,
      temp_high: d.number_high,
      wind: wind(d)
    }))
  }
}

/** 必需数据齐全时才渲染单卡，缺失时保留同次搜索的其他结果。 */
function getCanonical(raw: Record<string, unknown>): CanonicalWeather | null {
  // 优先用 backend 注入的 _canonical
  const canonical = raw._canonical as CanonicalWeather | undefined

  if (canonical && canonical.today?.summary && canonical.today?.temp_low && canonical.today?.temp_high) {
    return canonical
  }

  // Fallback 到老 schema (raw.jsonData.display_info.day[])
  return legacyToCanonical(raw)
}

/** 按天气描述文字映射到 emoji 图标。粗匹配关键字, 兜底返回温度计。 */
function weatherEmoji(summary: string | undefined): string {
  if (!summary) {
    return '🌡️'
  }

  const s = summary.toLowerCase()

  if (summary.includes('雷')) {
    return '⛈️'
  }

  if (summary.includes('雪') || s.includes('snow')) {
    return '❄️'
  }

  if (summary.includes('雨') || s.includes('rain')) {
    return '🌧️'
  }

  if (summary.includes('雾') || summary.includes('霾') || s.includes('fog')) {
    return '🌫️'
  }

  if (summary.includes('阴') || s.includes('overcast')) {
    return '☁️'
  }

  if (summary.includes('云') || s.includes('cloud')) {
    return '🌤️'
  }

  if (summary.includes('晴') || s.includes('sun') || s.includes('clear')) {
    return '☀️'
  }

  return '🌡️'
}

/** 温度按统一文字形式展示，缺值保留占位。 */
function formatTemp(low: string | undefined, high: string | undefined): string {
  return `${low ?? '?'}° ~ ${high ?? '?'}°`
}

/** 当前与历史天气使用同一组件，已有元数据按需显示。 */
export function WeatherCard({ card }: VRCardProps) {
  const data = getCanonical(card.raw)

  if (!data) {
    return null
  }

  const location = data.location ?? '天气'
  const { today, forecast = [] } = data

  const todayExtra: string[] = []

  if (today.wind) {
    todayExtra.push(today.wind)
  }

  if (today.humidity) {
    todayExtra.push(`${cardText('humidity')} ${today.humidity}`)
  }

  if (today.aqi) {
    todayExtra.push(`AQI ${today.aqi}`)
  }

  if (today.temp_feel) {
    todayExtra.push(`${cardText('feelsLike')} ${today.temp_feel}°`)
  }

  return (
    <div className="vrcard vrcard-weather">
      <div className="vrcard-header">
        <span className="vrcard-title">{location}</span>
        <span className="vrcard-sub">
          {cardText('today')}
          {today.week ? ` · ${today.week}` : ''}
        </span>
      </div>

      <div className="vrcard-weather-today">
        <span className="vrcard-weather-emoji">{weatherEmoji(today.summary)}</span>
        <div className="vrcard-weather-today-main">
          <div className="vrcard-weather-today-temp">{formatTemp(today.temp_low, today.temp_high)}</div>
          <div className="vrcard-weather-today-desc">{today.summary}</div>
        </div>
      </div>

      {todayExtra.length > 0 && (
        <div className="vrcard-weather-today-extra">
          {todayExtra.map((s, i) => (
            <span key={i}>{s}</span>
          ))}
        </div>
      )}

      {today.forbidden && (
        <div className="vrcard-weather-forbidden">
          {cardText('restriction')} {today.forbidden}
        </div>
      )}

      {forecast.length > 0 && (
        <div className="vrcard-weather-rest">
          {forecast.map((d, i) => (
            <div className="vrcard-weather-rest-row" key={i}>
              <span className="vrcard-weather-rest-date">
                {d.date}
                {d.week ? ` ${d.week}` : ''}
              </span>
              <span className="vrcard-weather-rest-emoji">{weatherEmoji(d.summary)}</span>
              <span className="vrcard-weather-rest-desc">{d.summary}</span>
              <span className="vrcard-weather-rest-temp">{formatTemp(d.temp_low, d.temp_high)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
