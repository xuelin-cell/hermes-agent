import './skills-mt.css'

import { useStore } from '@nanostores/react'
import { IconPuzzle } from '@tabler/icons-react'
import type { ComponentProps, ReactNode } from 'react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'

import connectorsIcon from '@/assets/skills-nav/connectors.svg?raw'
import expertsIcon from '@/assets/skills-nav/experts.svg?raw'
import skillsIcon from '@/assets/skills-nav/skills.svg?raw'
import { useI18n } from '@/i18n'
import { Search } from '@/lib/icons'
import { $codeWorkspace } from '@/store/workspace-category'

import { useSkillsCopy } from './copy'
import { SkillsHub } from './skills-hub'

interface CapabilitiesPageProps extends ComponentProps<'section'> {
  connectors: (searchContainer: HTMLDivElement | null) => ReactNode
  experts?: ReactNode
  mode: 'experts' | 'skills' | 'plugins' | 'connectors'
  onModeChange: (mode: 'experts' | 'skills' | 'plugins' | 'connectors') => void
  plugins: ReactNode
  scopeSelector?: ReactNode
  skills: Omit<ComponentProps<typeof SkillsHub>, 'query'>
}

/** 扩展页标题跟随工作区：代码开发显示技能、插件、连接器，其他工作区显示专家、技能、连接器。 */
export function CapabilitiesPage({
  connectors,
  experts,
  mode,
  onModeChange,
  plugins,
  scopeSelector,
  skills,
  ...props
}: CapabilitiesPageProps) {
  const t = useSkillsCopy()
  const { t: copy } = useI18n()
  const codeWorkspace = useStore($codeWorkspace)
  const [connectorSearchContainer, setConnectorSearchContainer] = useState<HTMLDivElement | null>(null)
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const expertQuery = params.get('q') ?? ''

  const searchLabel =
    mode === 'experts' ? t(params.get('shelf') === 'kits' ? 'searchKits' : 'searchExperts') : t('search')

  const titles: Array<{ icon?: string; id: 'experts' | 'skills' | 'plugins' | 'connectors'; label: string }> = [
    ...(!codeWorkspace && experts ? [{ id: 'experts' as const, icon: expertsIcon, label: t('experts') }] : []),
    { id: 'skills', icon: skillsIcon, label: t('skills') },
    ...(codeWorkspace ? [{ id: 'plugins' as const, label: copy.skills.tabPlugins }] : []),
    { id: 'connectors', icon: connectorsIcon, label: t('connectors') }
  ]

  return (
    <section {...props} className="mt-skills-page">
      <header className="mt-skills-head">
        <nav className="mt-skills-titles">
          {titles.map(({ id, icon, label }) => (
            <button
              aria-current={id === mode ? 'page' : undefined}
              className="mt-skills-title"
              key={id}
              onClick={() => onModeChange(id)}
              type="button"
            >
              {icon ? (
                <span aria-hidden className="mt-skills-title-icon" dangerouslySetInnerHTML={{ __html: icon }} />
              ) : (
                <IconPuzzle aria-hidden size={20} stroke={1.75} />
              )}
              {label}
            </button>
          ))}
        </nav>
        {mode === 'skills' || mode === 'experts' ? (
          <label className="mt-skills-search">
            <Search className="size-4 shrink-0" />
            <input
              aria-label={searchLabel}
              onChange={event => {
                const value = event.target.value

                if (mode !== 'experts') {
                  setQuery(value)

                  return
                }

                setParams(
                  current => {
                    const next = new URLSearchParams(current)

                    if (value) {
                      next.set('q', value)
                    } else {
                      next.delete('q')
                    }

                    return next
                  },
                  { replace: true }
                )
              }}
              placeholder={searchLabel}
              value={mode === 'experts' ? expertQuery : query}
            />
          </label>
        ) : mode === 'connectors' ? (
          <div ref={setConnectorSearchContainer} />
        ) : null}
      </header>
      {scopeSelector}
      {mode === 'experts' ? (
        <div className="mt-experts-body">{experts}</div>
      ) : mode === 'skills' ? (
        <div className="mt-skills-body">
          <SkillsHub {...skills} query={query} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {mode === 'plugins' ? plugins : connectors(connectorSearchContainer)}
        </div>
      )}
    </section>
  )
}
