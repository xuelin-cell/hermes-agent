import type { ExpertCard, ExpertDirectory } from './types'

/** The picker's two groups: the recently summoned (newest first), then everyone else by name. */
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

/** The expert whose profile *profile* is, or null for an ordinary profile. */
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

/** Quick prompts for the empty chat, the opening prompt first when the package left it out. */
export function quickPrompts(expert: ExpertCard, limit = 3): string[] {
  const prompts = expert.quick_prompts.map(prompt => prompt.trim()).filter(Boolean)
  const opening = openingPrompt(expert)

  if (opening && !prompts.includes(opening)) {
    prompts.unshift(opening)
  }

  return prompts.slice(0, limit)
}
