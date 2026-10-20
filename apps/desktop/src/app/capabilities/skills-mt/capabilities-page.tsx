import './skills-mt.css'

import { IconApps, IconPlugConnected, IconSparkles } from '@tabler/icons-react'
import type { ComponentProps, ReactNode } from 'react'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { contributedRoutes, ROUTES_AREA } from '@/app/routes'
import { useContributions } from '@/contrib/react/use-contributions'
import { Search } from '@/lib/icons'

import { useSkillsCopy } from './copy'
import { SkillsHub } from './skills-hub'

// 专家在套件插件的页面里；插件没启动（如云端普通用户）就不出这个标题。
const EXPERTS_PATH = '/kits'

interface CapabilitiesPageProps extends ComponentProps<'section'> {
  connectors: ReactNode
  mode: 'skills' | 'connectors'
  onModeChange: (mode: 'skills' | 'connectors') => void
  scopeSelector?: ReactNode
  skills: Omit<ComponentProps<typeof SkillsHub>, 'query'>
}

/** 普通用户的「技能与工具」页：顶部 专家 | 技能 | 连接器 大标题和搜索框（对照 UniWork 的扩展页）。 */
export function CapabilitiesPage({
  connectors,
  mode,
  onModeChange,
  scopeSelector,
  skills,
  ...props
}: CapabilitiesPageProps) {
  const t = useSkillsCopy()
  const navigate = useNavigate()
  const routes = useContributions(ROUTES_AREA)
  const [query, setQuery] = useState('')
  const hasExperts = contributedRoutes(routes).some(route => route.path === EXPERTS_PATH)

  const titles: Array<{ icon: typeof IconApps; id: 'experts' | 'skills' | 'connectors'; label: string }> = [
    ...(hasExperts ? [{ id: 'experts' as const, icon: IconSparkles, label: t('experts') }] : []),
    { id: 'skills', icon: IconApps, label: t('skills') },
    { id: 'connectors', icon: IconPlugConnected, label: t('connectors') }
  ]

  return (
    <section {...props} className="mt-skills-page">
      <header className="mt-skills-head">
        <nav className="mt-skills-titles">
          {titles.map(({ id, icon: Icon, label }) => (
            <button
              aria-current={id === mode ? 'page' : undefined}
              className="mt-skills-title"
              key={id}
              onClick={() => (id === 'experts' ? navigate(EXPERTS_PATH) : onModeChange(id))}
              type="button"
            >
              <Icon aria-hidden size={20} stroke={1.75} />
              {label}
            </button>
          ))}
        </nav>
        {mode === 'skills' ? (
          <label className="mt-skills-search">
            <Search className="size-4 shrink-0" />
            <input onChange={event => setQuery(event.target.value)} placeholder={t('search')} value={query} />
          </label>
        ) : null}
      </header>
      {scopeSelector}
      {mode === 'skills' ? (
        <div className="mt-skills-body">
          <SkillsHub {...skills} query={query} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col pt-2">{connectors}</div>
      )}
    </section>
  )
}
