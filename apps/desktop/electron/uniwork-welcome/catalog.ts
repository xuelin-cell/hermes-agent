export const WELCOME_CATALOG_CHANNEL = 'hermes:uniwork-welcome:catalog'
export type WelcomeLocale = 'zh-CN' | 'en'

export interface WelcomeTemplate {
  id: string
  name: string
  prompt: string
  sort: number
  enabled: true
}

export interface WelcomeCategory {
  id: string
  name: string
  icon?: string
  sort: number
  enabled: true
  templates: WelcomeTemplate[]
}

/** 目录文字只作纯文本，拒绝空值、超长字段和非对象条目。 */
function text(value: unknown, limit = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
}

/** 未指定排序值的条目排在末尾，同序保持服务端原顺序。 */
function order(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

/** 校验元景三级目录，只选办公模块，不把编程模块作为缺失时的替代。 */
export function normalizeOfficeCatalog(value: unknown): WelcomeCategory[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { modules?: unknown }).modules)) {
    throw new Error('办公模板目录格式无效。')
  }

  const modules = (value as { modules: Record<string, unknown>[] }).modules
  const office = modules.find(item => item && item.id === 'office' && item.enabled === true)

  if (!office) {
    return []
  }

  if (!Array.isArray(office.tags)) {
    throw new Error('办公模板分类格式无效。')
  }

  const seen = new Set<string>()
  const categories: WelcomeCategory[] = []

  for (const row of office.tags.slice(0, 100)) {
    if (
      !row ||
      row.enabled !== true ||
      !text(row.id) ||
      !text(row.name) ||
      seen.has(row.id) ||
      !Array.isArray(row.templates)
    ) {
      continue
    }

    const ids = new Set<string>()
    const templates: WelcomeTemplate[] = []

    for (const item of row.templates.slice(0, 100)) {
      if (
        !item ||
        item.enabled !== true ||
        !text(item.id) ||
        !text(item.name) ||
        !text(item.prompt, 32_768) ||
        ids.has(item.id)
      ) {
        continue
      }

      ids.add(item.id)
      templates.push({ id: item.id, name: item.name, prompt: item.prompt, enabled: true, sort: order(item.sort) })
    }

    if (!templates.length) {
      continue
    }

    seen.add(row.id)
    categories.push({
      id: row.id,
      name: row.name,
      enabled: true,
      sort: order(row.sort),
      ...(text(row.icon, 128) ? { icon: row.icon.trim() } : {}),
      templates: templates.sort((a, b) => a.sort - b.sort)
    })
  }

  return categories.sort((a, b) => a.sort - b.sort)
}
