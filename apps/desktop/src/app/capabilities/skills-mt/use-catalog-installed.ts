import { useQuery } from '@tanstack/react-query'
import { useCallback, useState } from 'react'

import { capabilityScoped } from '@/api/client'
import { type ProfileScope, profileScopeKey } from '@/hermes'
import { isBrowserShell } from '@/lib/browser-shell'
import type { SkillHubSearchResponse } from '@/types/hermes'

import { SKILLS_QUERY_KEY } from '../skills/skills-data'

import { type CatalogIdentity, isCatalogInstalled } from './catalog'

// 后端装市场技能时把条目 id 记进 skills/.hub/lock.json，前端现成能读到它的只有 hub 搜索接口返回的
// installed（{目录 id: {name}}）。只查 official 源、q=e：本地 optional-skills 能命中 50 条以上，
// official 源就不会再去 GitHub 补列表，整个请求只读本地文件（约 0.3 秒）。q 留空后端直接回空表。
const INSTALLED_RECORDS_PATH = '/api/skills/hub/search?q=e&source=official&limit=1'

async function getInstalledRecords(profile: ProfileScope): Promise<Map<string, string>> {
  const response = await window.hermesDesktop.api<SkillHubSearchResponse>({
    ...capabilityScoped(profile),
    path: INSTALLED_RECORDS_PATH,
    timeoutMs: 45_000
  })

  const names = new Map<string, string>()

  for (const [id, entry] of Object.entries(response?.installed ?? {})) {
    if (typeof entry?.name === 'string' && entry.name) {
      names.set(id, entry.name)
    }
  }

  return names
}

/**
 * 推荐 / 技能市场卡片的「已安装」判断：显示名不是装好后的技能名，按安装记录对（见 catalog.isCatalogInstalled）。
 * 记录挂在 SKILLS_QUERY_KEY 下，安装、卸载后刷新技能列表时跟着刷新。active 为 false 时不请求，只靠猜。
 */
export function useCatalogInstalled(profile: ProfileScope, installedNames: ReadonlySet<string>, active: boolean) {
  const scopeKey = profileScopeKey(profile)

  const records = useQuery({
    queryKey: [...SKILLS_QUERY_KEY, 'mt-catalog-installed', scopeKey],
    queryFn: () => getInstalledRecords(profile),
    // 浏览器构建（云端）里市场安装还在开发中，没有记录可读。
    enabled: active && !isBrowserShell() && Boolean(window.hermesDesktop?.api),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false
  })

  // 刚装完、记录还没重新拉回来时先用安装接口返回的名字；按安装开始时的范围记，切了配置档不串。
  const [learned, setLearned] = useState<ReadonlyMap<string, string>>(() => new Map())

  const isInstalled = useCallback(
    (entry: CatalogIdentity) =>
      isCatalogInstalled(entry, installedNames, records.data?.get(entry.id) ?? learned.get(`${scopeKey}\n${entry.id}`)),
    [installedNames, learned, records.data, scopeKey]
  )

  const remember = useCallback((scope: string, id: string, name: string) => {
    setLearned(current => new Map(current).set(`${scope}\n${id}`, name))
  }, [])

  return { isInstalled, remember, scopeKey }
}
