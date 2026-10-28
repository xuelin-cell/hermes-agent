import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { ProfileScope, UniWorkSkill } from '@/hermes'
import {
  getUniWorkMarketCategories,
  getUniWorkMarketSkills,
  getUniWorkRecommendedCategories,
  getUniWorkRecommendedSkills,
  setSkillEnabled
} from '@/hermes'
import { useI18n } from '@/i18n'
import { skillMarketInstallPending } from '@/lib/browser-shell'
import { ExternalLink, Loader2 } from '@/lib/icons'
import { installHubSkill, uninstallHubSkill } from '@/store/hub-actions'
import { notify, notifyError } from '@/store/notifications'
import type { SkillInfo } from '@/types/hermes'

import { SKILLS_QUERY_KEY } from '../skills/skills-data'

import {
  canUninstall,
  type ExampleKey,
  filterCatalog,
  filterInstalled,
  installedBadge,
  installedCounts,
  type InstalledFilter,
  tryPrompt
} from './catalog'
import { useSkillsCopy } from './copy'
import { installMarketSkillWithApproval } from './market-install'
import { CatalogCard, InstalledCard } from './skill-cards'
import { SkillDetailDialog } from './skill-detail-dialog'
import { trySkillInNewChat } from './try-skill'
import { useCatalogInstalled } from './use-catalog-installed'

const MARKET_HUB_URL = 'https://skillhub.ai-yuanjing.com:8081/skill-square/'

type HubTab = 'recommended' | 'market' | 'installed'

/** 推荐技能比市场技能多一句使用引导（skill_guide），「去试试」优先用它。 */
type CatalogSkill = UniWorkSkill & { skill_guide?: string | null }

interface SkillsHubProps {
  hiddenKitSkills: number
  installedError: unknown
  installedNames: ReadonlySet<string>
  installedPending: boolean
  onRefresh: () => void
  profile?: ProfileScope
  query: string
  skills: readonly SkillInfo[]
}

/** 技能页正文：推荐 / 技能市场 / 已安装（对照 UniWork 的 SkillsPage）。 */
export function SkillsHub({
  hiddenKitSkills,
  installedError,
  installedNames,
  installedPending,
  onRefresh,
  profile,
  query,
  skills
}: SkillsHubProps) {
  const t = useSkillsCopy()
  const { locale } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<HubTab>('recommended')
  const [category, setCategory] = useState('all')
  const [filter, setFilter] = useState<InstalledFilter>('all')
  const [installing, setInstalling] = useState<string | null>(null)
  const [toggling, setToggling] = useState<ReadonlySet<string>>(new Set())
  const [detail, setDetail] = useState<SkillInfo | null>(null)
  const [removing, setRemoving] = useState<SkillInfo | null>(null)

  // 与原技能市场同一组查询键，切回开发者模式的原页面时缓存还能用。
  const recommended = useQuery({
    queryKey: ['uniwork-skill-recommended'],
    queryFn: getUniWorkRecommendedSkills,
    enabled: tab === 'recommended' || tab === 'installed',
    staleTime: 60_000
  })

  const recommendedCategories = useQuery({
    queryKey: ['uniwork-skill-recommended-categories'],
    queryFn: getUniWorkRecommendedCategories,
    enabled: tab === 'recommended',
    staleTime: 10 * 60_000
  })

  const market = useQuery({
    queryKey: ['uniwork-skill-market', category],
    queryFn: () => getUniWorkMarketSkills(category),
    enabled: tab === 'market',
    staleTime: 60_000
  })

  const marketCategories = useQuery({
    queryKey: ['uniwork-skill-market-categories'],
    queryFn: getUniWorkMarketCategories,
    enabled: tab === 'market',
    staleTime: 10 * 60_000
  })

  const catalog = tab === 'market' ? market : recommended
  const categories = tab === 'market' ? marketCategories.data : recommendedCategories.data

  // 没有从市场 / 技能库装过的技能就不用查安装记录。
  const catalogInstalled = useCatalogInstalled(
    profile,
    installedNames,
    tab !== 'installed' && skills.some(skill => skill.provenance === 'hub')
  )

  const visibleCategories = useMemo(
    () =>
      (categories ?? []).filter(item => {
        const id = item.id.trim().toLocaleLowerCase()
        const name = item.name.trim().toLocaleLowerCase()

        return id !== 'all' && name !== 'all' && name !== '全部'
      }),
    [categories]
  )

  const visibleCatalog = useMemo(
    () => filterCatalog((catalog.data ?? []) as CatalogSkill[], category, query),
    [catalog.data, category, query]
  )

  const visibleInstalled = useMemo(() => filterInstalled(skills, filter, query), [filter, query, skills])
  const counts = useMemo(() => installedCounts(skills), [skills])

  // 推荐技能的使用引导按名称索引，已安装卡片的「去试试」也能用上。
  const guides = useMemo(() => {
    const byName = new Map<string, string>()

    for (const skill of (recommended.data ?? []) as CatalogSkill[]) {
      if (skill.skill_guide?.trim()) {
        byName.set(skill.name, skill.skill_guide)
      }
    }

    return byName
  }, [recommended.data])

  const example = (key: ExampleKey, name: string) => t('example', key, name)

  function startTry(skill: { category?: string; description?: string; name: string }, guide?: string | null) {
    trySkillInNewChat(tryPrompt(skill, example, guide ?? guides.get(skill.name)))
  }

  async function install(skill: CatalogSkill) {
    // 已安装列表还没加载出来时先不装，免得把装过的再下载一遍。
    if (catalogInstalled.isInstalled(skill) || (installedPending && !installedError)) {
      return
    }

    // 浏览器构建（云端）里市场安装还在开发中，见 lib/browser-shell。
    const pending = skillMarketInstallPending(locale.startsWith('zh') ? 'zh' : 'en')

    if (pending) {
      notify({ kind: 'info', message: pending })

      return
    }

    setInstalling(skill.id)

    const scope = catalogInstalled.scopeKey

    try {
      if (skill.package_download_path || skill.download_url) {
        const result = await installMarketSkillWithApproval(skill, profile, t)

        if (!result) {
          return
        }

        if (!result.ok || !result.name || !result.install_path) {
          throw new Error(t('incomplete'))
        }

        catalogInstalled.remember(scope, skill.id, result.name)
        await queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
      } else if (skill.clawhub_url) {
        await installHubSkill(skill.clawhub_url, profile)
      } else {
        throw new Error(t('noPackageError'))
      }

      notify({ kind: 'success', title: t('installDone', skill.name), message: t('availableNext') })
    } catch (error) {
      notifyError(error, t('installFailed'))
    } finally {
      setInstalling(null)
    }
  }

  async function toggle(skill: SkillInfo, next: boolean) {
    setToggling(current => new Set(current).add(skill.name))

    try {
      await setSkillEnabled(skill.name, next, profile)
      await queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
    } catch (error) {
      notifyError(error, t('toggleFailed'))
    } finally {
      setToggling(current => {
        const rest = new Set(current)
        rest.delete(skill.name)

        return rest
      })
    }
  }

  async function uninstall(skill: SkillInfo) {
    try {
      await uninstallHubSkill(skill.name, skill.name, profile)
    } catch (error) {
      throw new Error(error instanceof Error && error.message ? error.message : t('uninstallFailed'))
    }

    notify({ kind: 'success', message: t('uninstalled') })
  }

  const tabs: Array<{ count?: number; id: HubTab; label: string }> = [
    { id: 'recommended', label: t('recommended') },
    { id: 'market', label: t('market') },
    { id: 'installed', label: t('installed'), count: skills.length }
  ]

  const emptyText = (fallback: string) => (query.trim() ? t('noMatch', query.trim()) : fallback)

  return (
    <>
      <div className="mt-skills-tabs" role="tablist">
        {tabs.map(item => (
          <button
            aria-selected={tab === item.id}
            className="mt-skills-tab"
            key={item.id}
            onClick={() => {
              setTab(item.id)
              setCategory('all')
            }}
            role="tab"
            type="button"
          >
            {item.label}
            {item.count !== undefined ? <span className="mt-skills-count">({item.count})</span> : null}
          </button>
        ))}
      </div>

      {tab === 'installed' ? (
        <>
          <div className="mt-skills-filters">
            <div aria-label={t('filterLabel')} className="mt-skills-segment" role="group">
              {(['all', 'enabled', 'disabled'] as const).map(id => (
                <button aria-pressed={filter === id} key={id} onClick={() => setFilter(id)} type="button">
                  {t(id)}
                  <span>{counts[id]}</span>
                </button>
              ))}
            </div>
          </div>
          {hiddenKitSkills > 0 ? (
            <button
              className="mt-skills-note"
              onClick={() => navigate('/capabilities?tab=experts&shelf=kits')}
              type="button"
            >
              {t('kitSkillsNote')}
            </button>
          ) : null}
          {installedError && installedPending ? (
            <div className="mt-skills-empty">
              {t('loadFailedInstalled')}
              <Button onClick={onRefresh} size="sm" variant="outline">
                {t('retry')}
              </Button>
            </div>
          ) : installedPending ? (
            <div className="mt-skills-empty">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : visibleInstalled.length === 0 ? (
            <div className="mt-skills-empty">
              {emptyText(
                filter === 'enabled'
                  ? t('emptyEnabled')
                  : filter === 'disabled'
                    ? t('emptyDisabled')
                    : t('emptyInstalled')
              )}
            </div>
          ) : (
            <div className="mt-skills-grid">
              {visibleInstalled.map(skill => (
                <InstalledCard
                  badge={installedBadge(skill)}
                  busy={toggling.has(skill.name)}
                  description={skill.description}
                  enabled={skill.enabled}
                  key={skill.name}
                  name={skill.name}
                  onDetail={() => setDetail(skill)}
                  onToggle={next => void toggle(skill, next)}
                  onTry={() => startTry(skill)}
                  onUninstall={canUninstall(skill) ? () => setRemoving(skill) : undefined}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="mt-skills-filters">
            <div className="mt-skills-cats">
              <button
                aria-pressed={category === 'all'}
                className="mt-skills-cat"
                onClick={() => setCategory('all')}
                type="button"
              >
                {t('all')}
              </button>
              {visibleCategories.map(item => (
                <button
                  aria-pressed={category === item.id}
                  className="mt-skills-cat"
                  key={item.id}
                  onClick={() => setCategory(item.id)}
                  type="button"
                >
                  {item.name}
                </button>
              ))}
            </div>
            {tab === 'market' ? (
              <a className="mt-skills-link" href={MARKET_HUB_URL} rel="noreferrer" target="_blank">
                <ExternalLink className="size-3.5" />
                {t('marketLink')}
              </a>
            ) : null}
          </div>
          {catalog.isLoading ? (
            <div className="mt-skills-empty">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : catalog.isError ? (
            <div className="mt-skills-empty">
              {tab === 'market' ? t('loadFailedMarket') : t('loadFailedRecommended')}
              <Button onClick={() => void catalog.refetch()} size="sm" variant="outline">
                {t('retry')}
              </Button>
            </div>
          ) : visibleCatalog.length === 0 ? (
            <div className="mt-skills-empty">
              {emptyText(tab === 'market' ? t('emptyMarket') : t('emptyRecommended'))}
            </div>
          ) : (
            <div className="mt-skills-grid">
              {visibleCatalog.map(skill => (
                <CatalogCard
                  description={skill.description}
                  iconUrl={skill.icon_url}
                  installable={Boolean(skill.package_download_path || skill.download_url || skill.clawhub_url)}
                  installed={catalogInstalled.isInstalled(skill)}
                  installing={installing === skill.id}
                  key={skill.id}
                  name={skill.name}
                  onInstall={() => void install(skill)}
                  onTry={() => startTry(skill, skill.skill_guide)}
                  provider={skill.provider || skill.category}
                />
              ))}
            </div>
          )}
        </>
      )}

      <SkillDetailDialog onClose={() => setDetail(null)} profile={profile} skill={detail} />
      <ConfirmDialog
        cancelLabel={t('cancel')}
        confirmLabel={t('uninstall')}
        description={t('uninstallBody')}
        destructive
        onClose={() => setRemoving(null)}
        onConfirm={() => (removing ? uninstall(removing) : undefined)}
        open={Boolean(removing)}
        title={removing ? t('uninstallTitle', removing.name) : ''}
      />
    </>
  )
}
