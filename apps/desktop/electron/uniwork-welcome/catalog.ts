export const WELCOME_CATALOG_CHANNEL = 'hermes:uniwork-welcome:catalog'
export type WelcomeLocale = 'zh-CN' | 'en'

export interface WelcomePayload {
  modules: unknown[]
  version?: string
}

export interface WelcomeTemplate {
  id: string
  name: string
  prompt: string
  sort: number
}

export interface WelcomeCategory {
  id: string
  name: string
  icon?: string
  sort: number
  templates: WelcomeTemplate[]
}

export interface WelcomeModule {
  id: string
  name: string
  workspace: 'work' | 'codex'
  sort: number
  tags: WelcomeCategory[]
}

/** 目录文字只作纯文本，拒绝空值、超长字段和非对象条目。 */
function text(value: unknown, limit = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
}

const CODE_MODULE_NAMES = new Set(['代码开发', '编程', 'code', 'programming', 'code development'])

export function workspaceForModuleName(name: string): 'work' | 'codex' {
  return CODE_MODULE_NAMES.has(name.trim().toLowerCase().replace(/\s+/g, ' ')) ? 'codex' : 'work'
}

/** 未指定排序值的条目排在末尾，同序保持服务端原顺序。 */
function order(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

/** 显示来自配置，执行模式由本地名称映射决定；模块业务 ID 和 enabled 均不参与处理。 */
export function normalizeWelcomeCatalog(value: unknown): WelcomeModule[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { modules?: unknown }).modules)) {
    throw new Error('办公模板目录格式无效。')
  }

  return (value as { modules: unknown[] }).modules
    .slice(0, 100)
    .flatMap((raw, index): WelcomeModule[] => {
      if (!raw || typeof raw !== 'object') {
        return []
      }

      const item = raw as Record<string, unknown>

      if (!text(item.name)) {
        return []
      }

      return [
        {
          id: `configured-module-${index}`,
          name: item.name,
          workspace: workspaceForModuleName(item.name),
          sort: order(item.sort),
          tags: normalizeWelcomeCategories(item.tags)
        }
      ]
    })
    .sort((a, b) => a.sort - b.sort)
}

function normalizeWelcomeCategories(value: unknown): WelcomeCategory[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const categories: WelcomeCategory[] = []

  for (const row of value.slice(0, 100)) {
    if (!row || !text(row.id) || !text(row.name) || seen.has(row.id) || !Array.isArray(row.templates)) {
      continue
    }

    const ids = new Set<string>()
    const templates: WelcomeTemplate[] = []

    for (const item of row.templates.slice(0, 100)) {
      if (!item || !text(item.id) || !text(item.name) || !text(item.prompt, 32_768) || ids.has(item.id)) {
        continue
      }

      ids.add(item.id)
      templates.push({ id: item.id, name: item.name, prompt: item.prompt, sort: order(item.sort) })
    }

    if (!templates.length) {
      continue
    }

    seen.add(row.id)
    categories.push({
      id: row.id,
      name: row.name,
      sort: order(row.sort),
      ...(text(row.icon, 128) ? { icon: row.icon.trim() } : {}),
      templates: templates.sort((a, b) => a.sort - b.sort)
    })
  }

  return categories.sort((a, b) => a.sort - b.sort)
}
