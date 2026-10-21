import { useContext, useState } from 'react'

import { providerIdOf } from '@/app/settings/models-mt/catalog'
import { prettifyModelId } from '@/app/settings/models-mt/model-name'
import { ModelMenuCloseContext } from '@/app/shell/model-menu-panel'
import { type ModelMenuHostProps, useModelMenuController } from '@/app/shell/use-model-menu-controller'
import { DropdownMenuItem, dropdownMenuRow, DropdownMenuSearch } from '@/components/ui/dropdown-menu'
import { Check, ImageIcon } from '@/lib/icons'
import { currentModelCapabilities } from '@/lib/model-options'

import { formatContextSize } from './context-usage'
import { useComposerModelCopy } from './copy'
import { type ComposerModelMeta, useComposerModelMeta } from './model-meta'

/** 普通模式只列设置中的模型；选择和思考预设仍交给原版会话控制器。 */
export function ComposerModelList(props: ModelMenuHostProps) {
  const t = useComposerModelCopy()
  const close = useContext(ModelMenuCloseContext)
  const { controller, defaultEffort, modelOptions } = useModelMenuController(props)
  const { rows, find, loading } = useComposerModelMeta()
  const [search, setSearch] = useState('')
  const current = controller.current
  const missing = current.model && !find(current.provider, current.model)

  const visibleRows: ComposerModelMeta[] = missing
    ? [
        {
          key: `current:${current.provider}:${current.model}`,
          endpointId: providerIdOf(current.provider),
          provider: current.provider,
          model: current.model,
          name: prettifyModelId(current.model),
          vision: false,
          plan: false
        },
        ...rows
      ]
    : rows

  const needle = search.trim().toLowerCase()
  const filtered = visibleRows.filter(row => `${row.name}\n${row.model}`.toLowerCase().includes(needle))

  /** 选中成功才应用该模型支持的预设，不把会话选择写成全局默认。 */
  const select = async (row: ComposerModelMeta) => {
    const caps = currentModelCapabilities(modelOptions.data, row.provider, row.model)
    const preset = controller.presetFor(row.provider, row.model)

    if ((await controller.select(row.model, row.provider)) === false) {
      return
    }

    controller.applyPreset(
      {
        effort: (caps?.reasoning ?? true) ? (preset.effort ?? defaultEffort) : undefined,
        fast: (caps?.fast ?? false) ? (preset.fast ?? false) : undefined
      },
      { model: row.model, provider: row.provider }
    )
    close?.()
  }

  return (
    <>
      {visibleRows.length > 8 && (
        <DropdownMenuSearch
          aria-label={t('search')}
          onValueChange={setSearch}
          placeholder={t('search')}
          value={search}
        />
      )}
      {loading ? (
        <DropdownMenuItem className={dropdownMenuRow} disabled>
          {t('loading')}
        </DropdownMenuItem>
      ) : filtered.length ? (
        filtered.map(row => {
          const selected = providerIdOf(row.provider) === providerIdOf(current.provider) && row.model === current.model

          return (
            <DropdownMenuItem
              className={dropdownMenuRow}
              data-current={selected || undefined}
              key={row.key}
              onSelect={event => {
                event.preventDefault()

                if (selected) {
                  close?.()
                } else {
                  void select(row)
                }
              }}
            >
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {row.contextWindow && (
                <span
                  aria-label={t('contextChip', formatContextSize(row.contextWindow))}
                  className="shrink-0 text-(--ui-text-tertiary)"
                >
                  {formatContextSize(row.contextWindow)}
                </span>
              )}
              {row.vision && <ImageIcon className="size-3.5 shrink-0 text-(--ui-text-tertiary)" />}
              {selected ? <Check className="size-3.5 shrink-0" /> : <span className="size-3.5 shrink-0" />}
            </DropdownMenuItem>
          )
        })
      ) : (
        <DropdownMenuItem className={dropdownMenuRow} disabled>
          {t(visibleRows.length ? 'noMatch' : 'empty')}
        </DropdownMenuItem>
      )}
    </>
  )
}
