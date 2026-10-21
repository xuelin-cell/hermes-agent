import type { ExpertCard, ExpertDirectory } from './types'

/** 召唤列表分两组：最近召唤过的（最新的在前），其余按名字排。 */
export function pickerGroups(directory: ExpertDirectory): { recent: ExpertCard[]; rest: ExpertCard[] } {
  const byName = new Map(directory.experts.map(expert => [expert.name, expert]))

  const recent = directory.recent
    .map(name => byName.get(name))
    .filter((expert): expert is ExpertCard => Boolean(expert))

  const seen = new Set(recent.map(expert => expert.name))

  const rest = directory.experts
    .filter(expert => !seen.has(expert.name))
    .sort((a, b) => a.display_name.localeCompare(b.display_name, 'zh'))

  return { recent, rest }
}

/** 按名字、职业、简介或标签在全部专家里找。空查询不返回列表。 */
export function searchExperts(directory: ExpertDirectory, query: string): ExpertCard[] {
  const needle = query.trim().toLocaleLowerCase()

  if (!needle) {
    return []
  }

  return directory.experts
    .filter(expert =>
      [expert.display_name, expert.profession, expert.description, expert.profile, ...expert.tags].some(field =>
        field.toLocaleLowerCase().includes(needle)
      )
    )
    .sort((a, b) => a.display_name.localeCompare(b.display_name, 'zh'))
}

/** 这个档案对应的专家；普通档案返回 null。 */
export function expertForProfile(directory: ExpertDirectory, profile: null | string | undefined): ExpertCard | null {
  const key = String(profile ?? '').trim()

  return key ? (directory.experts.find(expert => expert.profile === key) ?? null) : null
}

/**
 * What a summon puts in the input box. 数字员工 filled the expert's opening
 * prompt and replaced whatever was typed (WorkBuddy does the same); an expert
 * without one leaves the box empty instead of guessing.
 */
export function openingPrompt(expert: ExpertCard): string {
  return expert.init_prompt.trim()
}

/**
 * 召唤后输入框下方「试试这样问」的卡片，和数字员工一致：只放宿主为这位专家写的那一条，
 * 它和已经填进输入框的开场白相同时不放；专家包里的短问法不用在这里。
 */
export function tryAskingPrompts(expert: ExpertCard): string[] {
  // 旧版后端给的专家名单没有这个字段（桌面端可能连着没升级的后端），缺了就当没有
  const prompt = (expert.try_asking ?? '').trim()

  return prompt && prompt !== openingPrompt(expert) ? [prompt] : []
}
