/**
 * The 「专家」 button beside the composer's "+" — 数字员工's summon picker.
 * The closed list is only the recently summoned. A search looks through every
 * installed expert.
 */

import { Codicon, Popover, PopoverContent, PopoverTrigger, Tip, usePluginI18n, useValue } from '@hermes/plugin-sdk'
import { useState } from 'react'

import { $bundled } from './bundled'
import { ExpertFace } from './expert-face'
import { $expertDirectory, loadExperts } from './experts-store'
import { summonExpert, warmExpert } from './summon'
import { pickerGroups, searchExperts } from './summon-model'
import type { ExpertCard } from './types'

function ExpertRow({ expert, onPick }: { expert: ExpertCard; onPick: (expert: ExpertCard) => void }) {
  return (
    <button
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-(--ui-bg-tertiary)"
      onClick={() => onPick(expert)}
      onPointerEnter={() => warmExpert(expert.profile)}
      type="button"
    >
      <ExpertFace expert={expert} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-(--ui-text-primary)">{expert.display_name}</span>
        {expert.profession && expert.profession !== expert.display_name ? (
          <span className="block truncate text-xs text-(--ui-text-tertiary)">{expert.profession}</span>
        ) : null}
      </span>
    </button>
  )
}

export function SummonPicker() {
  const t = usePluginI18n('uniwork-kits')
  const directory = useValue($expertDirectory)
  const bundled = useValue($bundled)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { recent } = pickerGroups(directory)
  const searching = query.trim().length > 0
  const results = searching ? searchExperts(directory, query) : recent

  const pick = (expert: ExpertCard) => {
    setOpen(false)
    setQuery('')
    summonExpert(expert)
  }

  return (
    <Popover
      onOpenChange={next => {
        setOpen(next)

        if (next) {
          void loadExperts()
        } else {
          setQuery('')
        }
      }}
      open={open}
    >
      <Tip label={t('summonHint')}>
        <PopoverTrigger asChild>
          <button
            aria-label={t('summon')}
            className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-(--ui-text-tertiary) hover:bg-(--ui-bg-tertiary) hover:text-(--ui-text-primary)"
            type="button"
          >
            <Codicon name="organization" />
            <span>{t('summon')}</span>
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="start" className="w-72 p-1.5" side="top">
        {directory.experts.length === 0 ? (
          <p className="m-0 px-2 py-3 text-xs text-(--ui-text-tertiary)">
            {bundled.running ? t('preparingExperts') : t('noExperts')}
          </p>
        ) : (
          <div>
            <input
              aria-label={t('searchExperts')}
              autoFocus
              className="mb-1 w-full rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 py-1.5 text-sm text-(--ui-text-primary) outline-none placeholder:text-(--ui-text-tertiary)"
              onChange={event => setQuery(event.target.value)}
              placeholder={t('searchExperts')}
              value={query}
            />
            <div className="max-h-80 overflow-y-auto">
              {searching ? null : (
                <p className="m-0 px-2 pt-1 pb-0.5 text-[0.7rem] text-(--ui-text-tertiary)">{t('recentExperts')}</p>
              )}
              {results.length ? (
                results.map(expert => <ExpertRow expert={expert} key={expert.name} onPick={pick} />)
              ) : (
                <p className="m-0 px-2 py-3 text-xs text-(--ui-text-tertiary)">
                  {searching ? t('searchExpertsEmpty') : t('noRecentExperts')}
                </p>
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
