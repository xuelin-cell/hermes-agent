import type { ReactNode } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { Plus } from '@/lib/icons'

import type { RECOMMENDED_CONNECTORS } from './recommended-catalog'

interface RecommendedConnectorProps {
  entry: (typeof RECOMMENDED_CONNECTORS)[number]
  onSelect: () => void
}

/** 卡片复用 HexAgent 的图标与信息层级，点击仅查看详情，不伪造授权操作。 */
export function RecommendedConnectorCard({ entry, onSelect }: RecommendedConnectorProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.recommended
  const item = copy.catalog[entry.id]

  return (
    <button aria-label={copy.details(item.name)} className="mt-connector-card" onClick={onSelect} type="button">
      <span className="mt-connector-card-top">
        <img alt="" className="mt-connector-icon" draggable={false} src={entry.icon} />
        <span className="mt-connector-name">{item.name}</span>
        <span aria-hidden="true" className="mt-connector-add">
          <Plus />
        </span>
      </span>
      <span className="mt-connector-description">{item.description}</span>
      <span className="mt-connector-provider">{item.provider}</span>
    </button>
  )
}

interface RecommendedConnectorDetailProps {
  entry: RecommendedConnectorProps['entry'] | null
  onClose: () => void
  children: ReactNode
}

/** 推荐项尚未接入授权服务，详情明确说明当前能力，并提供原生 MCP 入口。 */
export function RecommendedConnectorDetail({ entry, onClose, children }: RecommendedConnectorDetailProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.recommended
  const item = entry ? copy.catalog[entry.id] : null

  return (
    <Dialog
      onOpenChange={open => {
        if (!open) {
          onClose()
        }
      }}
      open={entry !== null}
    >
      {entry && item && (
        <DialogContent bodyClassName="gap-5 p-7" className="max-w-xl">
          <img alt="" className="mt-connector-icon" src={entry.icon} />
          <div className="grid gap-2">
            <DialogTitle className="text-xl">{item.name}</DialogTitle>
            <p className="text-sm text-(--ui-text-tertiary)">{item.provider}</p>
          </div>
          <DialogDescription className="text-sm leading-relaxed">{item.description}</DialogDescription>
          <div className="grid gap-2 border-t border-(--stroke-nous) pt-5">
            <p className="text-sm font-medium">{copy.unavailable}</p>
            <p className="text-sm leading-relaxed text-(--ui-text-tertiary)">{copy.unavailableHint}</p>
          </div>
          <div className="flex justify-end">{children}</div>
        </DialogContent>
      )}
    </Dialog>
  )
}
