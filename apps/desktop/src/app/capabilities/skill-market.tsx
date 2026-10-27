import './catalog/catalog.css'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import type * as React from 'react'
import { useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Masonry } from '@/components/ui/masonry'
import type { ProfileScope, UniWorkSkill } from '@/hermes'
import {
  getUniWorkMarketCategories,
  getUniWorkMarketSkills,
  getUniWorkRecommendedCategories,
  getUniWorkRecommendedSkills,
  installUniWorkSkill
} from '@/hermes'
import { skillMarketInstallPending } from '@/lib/browser-shell'
import { Loader2, Plus, Search } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { installHubSkill } from '@/store/hub-actions'
import { notify, notifyError } from '@/store/notifications'

import { CARD_ACCENTS } from './catalog/catalog-card'
// desktop-mt: 显示名不是装好后的技能名，「已安装」按安装记录判断。
import { useCatalogInstalled } from './skills-mt/use-catalog-installed'
import { SKILLS_QUERY_KEY } from './skills/skills-data'

type MarketTab = 'recommended' | 'market' | 'installed'

interface SkillMarketProps extends React.ComponentProps<'section'> {
  installed: React.ReactNode
  installedCount: number
  installedNames: ReadonlySet<string>
  profile?: ProfileScope
}

const isChinese = () => typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language)

export function SkillMarket({ installed, installedCount, installedNames, profile, className }: SkillMarketProps) {
  const zh = isChinese()
  const queryClient = useQueryClient()
  // Preserve the former Skills-page landing behavior: management opens first;
  // discovery is one click away in Recommended / Skill Market.
  const [tab, setTab] = useState<MarketTab>('installed')
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [installing, setInstalling] = useState<string | null>(null)

  const marketCategories = useQuery({
    queryKey: ['uniwork-skill-market-categories'],
    queryFn: getUniWorkMarketCategories,
    enabled: tab === 'market',
    staleTime: 10 * 60_000
  })

  const recommendedCategories = useQuery({
    queryKey: ['uniwork-skill-recommended-categories'],
    queryFn: getUniWorkRecommendedCategories,
    enabled: tab === 'recommended',
    staleTime: 10 * 60_000
  })

  const marketSkills = useQuery({
    queryKey: ['uniwork-skill-market', category],
    queryFn: () => getUniWorkMarketSkills(category),
    enabled: tab === 'market',
    staleTime: 60_000
  })

  const recommendedSkills = useQuery({
    queryKey: ['uniwork-skill-recommended'],
    queryFn: getUniWorkRecommendedSkills,
    enabled: tab === 'recommended',
    staleTime: 60_000
  })

  const skills = tab === 'market' ? marketSkills.data : recommendedSkills.data
  const categories = tab === 'market' ? marketCategories.data : recommendedCategories.data
  const catalogInstalled = useCatalogInstalled(profile, installedNames, tab !== 'installed') // desktop-mt

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()

    return (skills ?? []).filter(skill => {
      const inCategory = category === 'all' || skill.category === category || skill.category_id === category

      const inSearch =
        !needle || `${skill.name} ${skill.description} ${skill.provider ?? ''}`.toLocaleLowerCase().includes(needle)

      return inCategory && inSearch
    })
  }, [category, query, skills])

  const visibleCategories = useMemo(
    () =>
      (categories ?? []).filter(item => {
        const id = item.id.trim().toLocaleLowerCase()
        const name = item.name.trim().toLocaleLowerCase()

        return id !== 'all' && name !== 'all' && name !== '全部'
      }),
    [categories]
  )

  async function install(skill: UniWorkSkill) {
    // desktop-mt: 按安装记录判断，显示名对不上装好后的技能名。
    if (catalogInstalled.isInstalled(skill)) {
      return
    }

    // Only a persistence-aware cloud bridge may enable instance installs.
    const pending = skillMarketInstallPending(zh ? 'zh' : 'en')

    if (pending) {
      notify({ kind: 'info', message: pending })

      return
    }

    setInstalling(skill.id)
    const scope = catalogInstalled.scopeKey // desktop-mt

    try {
      if (skill.package_download_path || skill.download_url) {
        const result = await installUniWorkSkill(skill, profile)
        if (!result.ok || !result.name || !result.install_path) {
          throw new Error(zh ? '技能安装未完成，请重试' : 'Skill installation did not complete. Please retry.')
        }

        catalogInstalled.remember(scope, skill.id, result.name) // desktop-mt
        await queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
      } else if (skill.clawhub_url) {
        await installHubSkill(skill.clawhub_url, profile)
      } else {
        throw new Error(zh ? '该技能暂时没有可安装的软件包' : 'No installable package is available.')
      }

      notify({
        kind: 'success',
        title: zh ? `${skill.name} 安装完成` : `${skill.name} installed`,
        message: zh ? '技能将在新会话中可用' : 'The skill will be available in new sessions.'
      })
    } catch (error) {
      notifyError(error, zh ? '安装失败' : 'Install failed')
    } finally {
      setInstalling(null)
    }
  }

  const tabs: Array<{ id: MarketTab; label: string; count?: number }> = [
    { id: 'recommended', label: zh ? '推荐' : 'Recommended' },
    { id: 'market', label: zh ? '技能市场' : 'Skill Market' },
    { id: 'installed', label: zh ? '已安装' : 'Installed', count: installedCount }
  ]

  return (
    <section className={cn('flex h-full min-h-0 flex-1 flex-col overflow-hidden', className)}>
      <div className="flex shrink-0 items-end justify-between gap-4 border-b border-(--ui-stroke-secondary) px-5 pt-2">
        <div className="flex gap-7">
          {tabs.map(item => (
            <button
              className={cn(
                'relative pb-2 text-sm font-semibold text-(--ui-text-tertiary)',
                tab === item.id &&
                  'text-(--ui-text-primary) after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-(--accent-primary)'
              )}
              key={item.id}
              onClick={() => {
                setTab(item.id)
                setCategory('all')
              }}
              type="button"
            >
              {item.label}
              {item.count !== undefined && (
                <span className="ml-2 rounded-full bg-(--ui-bg-quaternary) px-2 py-0.5 text-xs">{item.count}</span>
              )}
            </button>
          ))}
        </div>
        {tab !== 'installed' && (
          <label className="mb-2 flex w-72 items-center gap-2 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary) px-3 py-1.5">
            <Search className="size-4 text-(--ui-text-tertiary)" />
            <input
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              onChange={event => setQuery(event.target.value)}
              placeholder={zh ? '搜索技能' : 'Search skills'}
              value={query}
            />
          </label>
        )}
      </div>

      {tab === 'installed' ? (
        installed
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <div className="mb-4 flex flex-wrap gap-2">
            <CategoryButton active={category === 'all'} onClick={() => setCategory('all')}>
              {zh ? '全部' : 'All'}
            </CategoryButton>
            {visibleCategories.map(item => (
              <CategoryButton active={category === item.id} key={item.id} onClick={() => setCategory(item.id)}>
                {item.name}
              </CategoryButton>
            ))}
            {tab === 'market' && (
              <a
                className="ml-auto text-xs text-(--ui-text-secondary) hover:text-(--ui-text-primary)"
                href="https://skillhub.ai-yuanjing.com:8081/skill-square/"
                rel="noreferrer"
                target="_blank"
              >
                ↗ {zh ? '元景万悟 Skills' : 'Yuanjing Skills'}
              </a>
            )}
          </div>
          {marketSkills.isLoading || recommendedSkills.isLoading ? (
            <div className="flex h-48 items-center justify-center">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (tab === 'market' ? marketSkills.isError : recommendedSkills.isError) ? (
            <div className="flex h-48 items-center justify-center text-sm text-(--ui-text-tertiary)">
              {zh ? '技能市场加载失败，请稍后重试' : 'Could not load the skill market. Try again later.'}
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-(--ui-text-tertiary)">
              {zh ? '没有找到匹配的技能' : 'No matching skills found.'}
            </div>
          ) : (
            <Masonry data-catalog-hover-group>
              {visible.map((skill, index) => {
                const installedSkill = catalogInstalled.isInstalled(skill) // desktop-mt

                return (
                  <MarketSkillCard
                    category={skill.category}
                    description={skill.description}
                    index={index}
                    installed={installedSkill}
                    installing={installing === skill.id}
                    key={skill.id}
                    name={skill.name}
                    onCategory={value => setCategory(value)}
                    onInstall={() => void install(skill)}
                    provider={skill.provider}
                    tags={skill.tags}
                    zh={zh}
                  />
                )
              })}
            </Masonry>
          )}
        </div>
      )}
    </section>
  )
}

interface MarketSkillCardProps {
  category?: string
  description: string
  index: number
  installed: boolean
  installing: boolean
  name: string
  onCategory: (category: string) => void
  onInstall: () => void
  provider?: string
  tags?: string[]
  zh: boolean
}

/** 使用已安装技能卡片的视觉规范展示市场技能，同时保留市场安装操作。 */
function MarketSkillCard({
  category,
  description,
  index,
  installed,
  installing,
  name,
  onCategory,
  onInstall,
  provider,
  tags = [],
  zh
}: MarketSkillCardProps) {
  return (
    <article
      className={cn(
        'group relative flex min-w-0 flex-col overflow-hidden rounded-lg border',
        CARD_ACCENTS[index % CARD_ACCENTS.length]
      )}
      data-catalog-card
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <h3 className="line-clamp-2 min-w-0 flex-1 break-words text-lg font-semibold leading-snug">{name}</h3>
          <span className="relative shrink-0 opacity-[.66] transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Button
              aria-label={installed ? (zh ? '已安装' : 'Installed') : zh ? '安装' : 'Install'}
              disabled={installed || installing}
              onClick={onInstall}
              size="icon-sm"
              variant="outline"
            >
              {installing ? <Loader2 className="size-4 animate-spin" /> : installed ? '✓' : <Plus className="size-4" />}
            </Button>
          </span>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <span className="truncate text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
            {provider || category}
          </span>
          <p className="line-clamp-4 min-h-0 text-[length:var(--conversation-caption-font-size)] leading-relaxed text-(--ui-text-secondary)">
            {description}
          </p>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-1 px-3 pb-3">
        {category && (
          <Button onClick={() => onCategory(category)} size="xs" variant="chip">
            {category}
          </Button>
        )}
        {tags.slice(0, 4).map(tag => (
          <Badge key={tag} variant="muted">
            {tag}
          </Badge>
        ))}
        {tags.length > 4 && <Badge variant="muted">+{tags.length - 4}</Badge>}
      </div>
    </article>
  )
}

function CategoryButton({
  active,
  children,
  onClick
}: {
  active: boolean
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      className={cn(
        'rounded-lg px-3 py-1.5 text-sm text-(--ui-text-secondary)',
        active && 'border border-(--accent-primary) bg-(--ui-bg-quaternary) font-semibold text-(--accent-primary)'
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}
