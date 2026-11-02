import { cardText } from './labels'
/**
 * Train VR card — railway timetable. 单/多车次共用本组件 (canonical.trains 列表).
 *
 * 数据源: backend `_canonical_train()` 注入到 `raw._canonical`, 两条路径:
 *   - passage variant (70083601/70330101): 单车次 + 详细 stops 时刻表
 *   - 老 display.subitem variant (703300 路线 / 703301 单车次): 1-N 车次, 仅 stops_count + 可能含票价
 *
 * 视觉:
 *   单车次详细: 大字 from→to, 全程时间, 然后展开 stops 列表 (12 截断)
 *   多车次路线: 每个车次一行 summary, 含票价
 */
import type { VRCardProps } from './types'

interface Stop {
  name: string
  arrive?: string | null
  depart?: string | null
  stay?: string | null
}

interface Train {
  number: string
  from_station?: string | null
  to_station?: string | null
  type?: string | null
  depart_time?: string | null
  arrive_time?: string | null
  duration?: string | null
  stops?: Stop[] | null // 详细时刻表 (passage 路径有, 老 schema 没)
  stops_count?: number | null // 兜底站数 (老 schema 有)
  price?: string | null
  ticket_type?: string | null
}

interface CanonicalTrain {
  trains: Train[]
  updated?: string | null
  url?: string | null
}

/** 必需数据齐全时才渲染单卡，缺失时保留同次搜索的其他结果。 */
function getCanonical(raw: Record<string, unknown>): CanonicalTrain | null {
  const c = raw._canonical as CanonicalTrain | undefined

  if (!c || !c.trains || c.trains.length === 0) {
    return null
  }

  // 至少一辆车有 number + 起终点才有渲染意义
  if (!c.trains.some(t => t.number && t.from_station && t.to_station)) {
    return null
  }

  return c
}

/** 按车型映射 emoji. 高铁/动车 → 子弹头; 城际/直达 → 高速; 其它 → 火车头. */
function trainEmoji(type: string | null | undefined): string {
  if (!type) {
    return '🚄'
  }

  if (type.includes('高铁') || type.includes('动车')) {
    return '🚄'
  }

  if (type.includes('城际') || type.includes('直达')) {
    return '🚅'
  }

  return '🚂'
}

const MAX_STOPS_VISIBLE = 12

/** 路线与经停数据按车次展示，长列表保留原有截断提示。 */
function TrainRow({ t }: { t: Train }) {
  const stops = t.stops ?? []
  const visibleStops = stops.slice(0, MAX_STOPS_VISIBLE)
  const truncated = stops.length - visibleStops.length
  const showStopsCount = !stops.length && t.stops_count

  return (
    <div className="vrcard-train-row">
      <div className="vrcard-train-num">
        <span className="vrcard-train-emoji">{trainEmoji(t.type)}</span>
        <span className="vrcard-title">{t.number}</span>
        {t.type && <span className="vrcard-tag">{t.type}</span>}
      </div>
      <div className="vrcard-train-route">
        <div className="vrcard-train-end">
          <div className="vrcard-train-time">{t.depart_time ?? '-'}</div>
          <div className="vrcard-train-station">{t.from_station ?? '?'}</div>
        </div>
        <div className="vrcard-train-arrow">→</div>
        <div className="vrcard-train-end">
          <div className="vrcard-train-time">{t.arrive_time ?? '-'}</div>
          <div className="vrcard-train-station">{t.to_station ?? '?'}</div>
        </div>
      </div>
      {(t.duration || showStopsCount || t.price) && (
        <div className="vrcard-train-meta">
          {t.duration && (
            <span>
              {cardText('duration')} {t.duration}
            </span>
          )}
          {showStopsCount && (
            <span>
              {cardText('stops')} {t.stops_count}
            </span>
          )}
          {t.price && (
            <span>
              ¥{t.price}
              {t.ticket_type ? ` (${t.ticket_type})` : ''}
            </span>
          )}
        </div>
      )}
      {visibleStops.length > 0 && (
        <div className="vrcard-train-stops">
          {visibleStops.map((s, i) => (
            <div className="vrcard-train-stop" key={i}>
              <span className="vrcard-train-stop-name">{s.name}</span>
              <span className="vrcard-train-stop-times">
                {s.arrive && (
                  <span>
                    {cardText('arrive')} {s.arrive}
                  </span>
                )}
                {s.depart && (
                  <span>
                    {cardText('depart')} {s.depart}
                  </span>
                )}
                {s.stay && (
                  <span>
                    {cardText('stay')} {s.stay}
                  </span>
                )}
              </span>
            </div>
          ))}
          {truncated > 0 && (
            <div className="vrcard-train-stop vrcard-train-stop-more">
              {cardText('moreStops')} {truncated}…
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const MAX_TRAINS_VISIBLE = 8

/** 火车结果只展示有限车次，保持聊天区域可读。 */
export function TrainCard({ card }: VRCardProps) {
  const c = getCanonical(card.raw)

  if (!c) {
    return null
  }

  const visibleTrains = c.trains.slice(0, MAX_TRAINS_VISIBLE)
  const truncated = c.trains.length - visibleTrains.length

  return (
    <div className="vrcard vrcard-train">
      {visibleTrains.map((t, i) => (
        <TrainRow key={i} t={t} />
      ))}
      {truncated > 0 && (
        <div className="vrcard-train-row vrcard-train-stop-more">
          {cardText('moreTrains')} {truncated}…
        </div>
      )}
    </div>
  )
}
