import './skills-mt.css'

import { useStore } from '@nanostores/react'
import { IconPuzzle } from '@tabler/icons-react'
import type { ComponentProps, ReactNode } from 'react'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { contributedRoutes, ROUTES_AREA } from '@/app/routes'
import connectorsIcon from '@/assets/skills-nav/connectors.svg?raw'
import expertsIcon from '@/assets/skills-nav/experts.svg?raw'
import skillsIcon from '@/assets/skills-nav/skills.svg?raw'
import { useContributions } from '@/contrib/react/use-contributions'
import { useI18n } from '@/i18n'
import { Search } from '@/lib/icons'
import { $codeWorkspace } from '@/store/workspace-category'

import { useSkillsCopy } from './copy'
import { SkillsHub } from './skills-hub'

// 专家在套件插件的页面里；插件没启动（如云端普通用户）就不出这个标题。
const EXPERTS_PATH = '/kits'

interface CapabilitiesPageProps extends ComponentProps<'section'> {
  connectors: (searchContainer: HTMLDivElement | null) => ReactNode
  mode: 'skills' | 'plugins' | 'connectors'
  onModeChange: (mode: 'skills' | 'plugins' | 'connectors') => void
  plugins: ReactNode
  scopeSelector?: ReactNode
  skills: Omit<ComponentProps<typeof SkillsHub>, 'query'>
}

/** 扩展页标题跟随工作区：代码开发显示技能、插件、连接器，其他工作区显示专家、技能、连接器。 */
export function CapabilitiesPage({
  connectors,
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
  const navigate = useNavigate()
  const routes = useContributions(ROUTES_AREA)
  const [query, setQuery] = useState('')
  const [connectorSearchContainer, setConnectorSearchContainer] = useState<HTMLDivElement | null>(null)
  const hasExperts = contributedRoutes(routes).some(route => route.path === EXPERTS_PATH)

  const titles: Array<{ icon?: string; id: 'experts' | 'skills' | 'plugins' | 'connectors'; label: string }> = [
    ...(!codeWorkspace && hasExperts ? [{ id: 'experts' as const, icon: expertsIcon, label: t('experts') }] : []),
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
              onClick={() => (id === 'experts' ? navigate(EXPERTS_PATH) : onModeChange(id))}
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
        {mode === 'skills' ? (
          <label className="mt-skills-search">
            <Search className="size-4 shrink-0" />
            <input onChange={event => setQuery(event.target.value)} placeholder={t('search')} value={query} />
          </label>
        ) : mode === 'connectors' ? (
          <div ref={setConnectorSearchContainer} />
        ) : null}
      </header>
      {scopeSelector}
      {mode === 'skills' ? (
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
