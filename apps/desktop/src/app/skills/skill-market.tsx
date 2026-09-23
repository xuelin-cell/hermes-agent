import { useQuery } from '@tanstack/react-query'
import type * as React from 'react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { ProfileScope, UniWorkSkill } from '@/hermes'
import {
  getUniWorkMarketCategories,
  getUniWorkMarketSkills,
  getUniWorkRecommendedCategories,
  getUniWorkRecommendedSkills,
  installUniWorkSkill
} from '@/hermes'
import { Loader2, Plus, Search } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { installHubSkill } from '@/store/hub-actions'
import { notify, notifyError } from '@/store/notifications'

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
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return (skills ?? []).filter(skill => {
      const inCategory = category === 'all' || skill.category === category || skill.category_id === category
      const inSearch = !needle || `${skill.name} ${skill.description} ${skill.provider ?? ''}`.toLocaleLowerCase().includes(needle)
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
    if (installedNames.has(skill.name)) return
    setInstalling(skill.id)
    try {
      if (skill.download_url || skill.package_download_path) {
        await installUniWorkSkill(skill, profile)
      } else if (skill.clawhub_url) {
        await installHubSkill(skill.clawhub_url, profile)
      } else {
        throw new Error(zh ? '该技能暂时没有可安装的软件包' : 'No installable package is available.')
      }
      notify({ kind: 'success', title: zh ? `正在安装 ${skill.name}` : `Installing ${skill.name}`, message: zh ? '可在操作日志中查看进度' : 'Follow progress in the action log.' })
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
              className={cn('relative pb-2 text-sm font-semibold text-(--ui-text-tertiary)', tab === item.id && 'text-(--ui-text-primary) after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-(--accent-primary)')}
              key={item.id}
              onClick={() => { setTab(item.id); setCategory('all') }}
              type="button"
            >
              {item.label}{item.count !== undefined && <span className="ml-2 rounded-full bg-(--ui-bg-quaternary) px-2 py-0.5 text-xs">{item.count}</span>}
            </button>
          ))}
        </div>
        {tab !== 'installed' && (
          <label className="mb-2 flex w-72 items-center gap-2 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary) px-3 py-1.5">
            <Search className="size-4 text-(--ui-text-tertiary)" />
            <input className="min-w-0 flex-1 bg-transparent text-sm outline-none" onChange={event => setQuery(event.target.value)} placeholder={zh ? '搜索技能' : 'Search skills'} value={query} />
          </label>
        )}
      </div>

      {tab === 'installed' ? installed : (
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <div className="mb-4 flex flex-wrap gap-2">
            <CategoryButton active={category === 'all'} onClick={() => setCategory('all')}>{zh ? '全部' : 'All'}</CategoryButton>
            {visibleCategories.map(item => <CategoryButton active={category === item.id} key={item.id} onClick={() => setCategory(item.id)}>{item.name}</CategoryButton>)}
            {tab === 'market' && <a className="ml-auto text-xs text-(--ui-text-secondary) hover:text-(--ui-text-primary)" href="https://skillhub.ai-yuanjing.com:8081/skill-square/" rel="noreferrer" target="_blank">↗ {zh ? '元景万悟 Skills' : 'Yuanjing Skills'}</a>}
          </div>
          {(marketSkills.isLoading || recommendedSkills.isLoading) ? (
            <div className="flex h-48 items-center justify-center"><Loader2 className="size-5 animate-spin" /></div>
          ) : (marketSkills.isError || recommendedSkills.isError) ? (
            <div className="flex h-48 items-center justify-center text-sm text-(--ui-text-tertiary)">{zh ? '技能市场加载失败，请稍后重试' : 'Could not load the skill market. Try again later.'}</div>
          ) : visible.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-(--ui-text-tertiary)">{zh ? '没有找到匹配的技能' : 'No matching skills found.'}</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {visible.map(skill => {
                const installedSkill = installedNames.has(skill.name)
                return <article className="min-h-30 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary) p-3.5" key={skill.id}>
                  <div className="flex items-start gap-2.5">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-(--accent-primary) text-xs font-bold text-white">{skill.name.slice(0, 2).toUpperCase()}</div>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-sm font-semibold">{skill.name}</h3>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-(--ui-text-secondary)">{skill.description}</p>
                      <p className="mt-1.5 truncate text-[0.68rem] text-(--ui-text-tertiary)">{skill.provider || skill.category}</p>
                    </div>
                    <Button aria-label={installedSkill ? (zh ? '已安装' : 'Installed') : (zh ? '安装' : 'Install')} disabled={installedSkill || installing === skill.id} onClick={() => void install(skill)} size="icon-sm" variant="outline">
                      {installing === skill.id ? <Loader2 className="size-4 animate-spin" /> : installedSkill ? '✓' : <Plus className="size-4" />}
                    </Button>
                  </div>
                </article>
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function CategoryButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return <button className={cn('rounded-lg px-3 py-1.5 text-sm text-(--ui-text-secondary)', active && 'border border-(--accent-primary) bg-(--ui-bg-quaternary) font-semibold text-(--accent-primary)')} onClick={onClick} type="button">{children}</button>
}
