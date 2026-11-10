import './skills-mt.css'

import type { ComponentProps, ReactNode } from 'react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'

import connectorsIcon from '@/assets/skills-nav/connectors.svg?raw'
import expertsIcon from '@/assets/skills-nav/experts.svg?raw'
import skillsIcon from '@/assets/skills-nav/skills.svg?raw'
import { Search } from '@/lib/icons'

import { useSkillsCopy } from './copy'
import { SkillUploadButton } from './skill-upload-button'
import { SkillsHub } from './skills-hub'

interface CapabilitiesPageProps extends ComponentProps<'section'> {
  connectors: (searchContainer: HTMLDivElement | null) => ReactNode
  experts?: ReactNode
  mode: 'experts' | 'skills' | 'connectors'
  onModeChange: (mode: 'experts' | 'skills' | 'connectors') => void
  scopeSelector?: ReactNode
  skills: Omit<ComponentProps<typeof SkillsHub>, 'query'>
}

/** 各场景共用能力页签，专家入口仅在实际注册时显示。 */
export function CapabilitiesPage({
  connectors,
  experts,
  mode,
  onModeChange,
  scopeSelector,
  skills,
  ...props
}: CapabilitiesPageProps) {
  const t = useSkillsCopy()
  const [connectorSearchContainer, setConnectorSearchContainer] = useState<HTMLDivElement | null>(null)
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const expertQuery = params.get('q') ?? ''

  const searchLabel =
    mode === 'experts' ? t(params.get('shelf') === 'kits' ? 'searchKits' : 'searchExperts') : t('search')

  const titles: Array<{ icon: string; id: 'experts' | 'skills' | 'connectors'; label: string }> = [
    ...(experts ? [{ id: 'experts' as const, icon: expertsIcon, label: t('experts') }] : []),
    { id: 'skills', icon: skillsIcon, label: t('skills') },
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
              <span aria-hidden className="mt-skills-title-icon" dangerouslySetInnerHTML={{ __html: icon }} />
              {label}
            </button>
          ))}
        </nav>
        {mode === 'skills' || mode === 'experts' ? (
          <label className={mode === 'skills' ? 'mt-skills-search mt-skills-search-right' : 'mt-skills-search'}>
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
        {mode === 'skills' && (
          <SkillUploadButton key={String(skills.profile)} onUploaded={skills.onRefresh} profile={skills.profile} />
        )}
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
          {connectors(connectorSearchContainer)}
        </div>
      )}
    </section>
  )
}
