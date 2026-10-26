import type { SkillInfo } from '@/types/hermes'

// 技能页（推荐 / 技能市场 / 已安装）的纯逻辑：卡片图标、徽标、筛选、「去试试」的示例提示词。
// 界面对照 UniWork 的 SkillsPage（hexagent uniwork_release）。

/** 卡片彩色方块的底色：按名称算出固定的一种，同一个技能每次颜色一样。 */
const MONOGRAM_COLORS = [
  '#6366f1',
  '#0ea5e9',
  '#14b8a6',
  '#f59e0b',
  '#f97316',
  '#8b5cf6',
  '#ec4899',
  '#10b981',
  '#3b82f6',
  '#ef4444'
] as const

/** 市场技能名常写成「显示名（英文名）」，图标字母取括号里的英文名；没有括号就用整个名称。 */
export function skillSlug(name: string): string {
  const match = name.match(/[（(]([^（）()]+)[）)]\s*$/)

  return (match?.[1] ?? name).trim()
}

/** 两个字母：按非字母数字切段，取前两段首字母或单段前两个字符；纯中文名取第一个汉字。 */
export function skillInitials(name: string): string {
  const slug = skillSlug(name)
  const segments = slug.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const raw = segments.length >= 2 ? segments[0][0] + segments[1][0] : (segments[0] ?? '').slice(0, 2)

  if (raw) {
    return raw.toUpperCase()
  }

  return slug.match(/[㐀-鿿]/)?.[0] ?? '?'
}

export function skillColor(name: string): string {
  let hash = 0

  for (const char of skillSlug(name)) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }

  return MONOGRAM_COLORS[hash % MONOGRAM_COLORS.length]
}

/** 只认 https 或内嵌图片地址，其余（含相对路径）一律用彩色方块。 */
export function usableIconUrl(url?: string | null): string | null {
  return url && /^(?:https:\/\/|data:image\/)/.test(url) ? url : null
}

export type InstalledBadge = 'bundled' | 'market' | 'agent'

/** 已安装技能的来源徽标：随应用带的 = 内置技能；从市场 / 技能库装的 = 技能市场；对话里学会的 = agent 创建。 */
export function installedBadge(skill: Pick<SkillInfo, 'provenance'>): InstalledBadge {
  return skill.provenance === 'hub' ? 'market' : skill.provenance === 'agent' ? 'agent' : 'bundled'
}

/** 只有从市场 / 技能库装的能卸载；内置的只能关，agent 创建的在开发者模式的原列表里管理。 */
export function canUninstall(skill: Pick<SkillInfo, 'provenance'>): boolean {
  return skill.provenance === 'hub'
}

export type InstalledFilter = 'all' | 'enabled' | 'disabled'

export function filterInstalled(skills: readonly SkillInfo[], filter: InstalledFilter, query: string): SkillInfo[] {
  const needle = query.trim().toLocaleLowerCase()

  return skills
    .filter(skill => (filter === 'all' ? true : filter === 'enabled' ? skill.enabled : !skill.enabled))
    .filter(skill => !needle || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function installedCounts(skills: readonly SkillInfo[]): Record<InstalledFilter, number> {
  const enabled = skills.filter(skill => skill.enabled).length

  return { all: skills.length, enabled, disabled: skills.length - enabled }
}

/** 推荐 / 市场列表按分类和搜索词过滤。 */
export function filterCatalog<
  T extends { category?: string; category_id?: string; description: string; name: string; provider?: string }
>(skills: readonly T[], category: string, query: string): T[] {
  const needle = query.trim().toLocaleLowerCase()

  return skills.filter(skill => {
    const inCategory = category === 'all' || skill.category === category || skill.category_id === category

    const inSearch =
      !needle || `${skill.name} ${skill.description} ${skill.provider ?? ''}`.toLocaleLowerCase().includes(needle)

    return inCategory && inSearch
  })
}

/** 推荐 / 技能市场条目里判断「装没装」要用到的字段（推荐条目才有包名）。 */
export interface CatalogIdentity {
  id: string
  name: string
  package_download_path?: string | null
  package_file_name?: string | null
}

// /api/skills 返回的技能名最多 64 个字符（tools/skills_tool.py），安装记录里的不截。
const SKILL_NAME_LIMIT = 64

/**
 * 没有安装记录时，猜这个条目装好后叫什么。装好后的名字取自包里 SKILL.md 的 name，
 * 和显示名、市场 id、包名都只是大多一致，所以只用这几个精确的键，宁可漏认也不错认
 * （错认成「已安装」，用户就点不了「+」了）。括号里的英文名不用：有的和别的条目 id 撞。
 */
export function catalogNameGuesses(entry: CatalogIdentity): string[] {
  const guesses = [entry.name.trim()]

  if (entry.package_download_path) {
    // 推荐：id 是 UUID；包名去掉 .zip（有的还带 __skillhub 后缀）多半就是技能名。
    const stem = (entry.package_file_name ?? '').trim().replace(/\.zip$/i, '')
    guesses.push(stem, stem.replace(/__skillhub$/i, ''))
  } else {
    // 技能市场：id 就是英文短名。
    guesses.push(entry.id.trim())
  }

  return [...new Set(guesses.filter(Boolean))]
}

/**
 * 目录卡片是否显示「已安装」。recorded 是安装记录里这个条目装成的技能名（后端安装记录或刚装完的返回值）：
 * 有记录只认记录，没有才猜；都要求这个名字现在还在已安装列表里，卸载后卡片自动变回「+」。
 */
export function isCatalogInstalled(
  entry: CatalogIdentity,
  installedNames: ReadonlySet<string>,
  recorded?: null | string
): boolean {
  const has = (name: string) => installedNames.has(name) || installedNames.has(name.slice(0, SKILL_NAME_LIMIT))

  if (recorded) {
    return has(recorded)
  }

  return catalogNameGuesses(entry).some(has)
}

// 「去试试」的示例提示词：先看技能自带的使用引导（推荐技能有 skill_guide），再按关键词，
// 再按市场分类，最后用通用说法。关键词表和文案照 UniWork 的 skillsMarket 文案。
const EXAMPLE_KEYWORDS: ReadonlyArray<readonly [readonly string[], ExampleKey]> = [
  [['ppt', 'pptx', '幻灯', 'slide', 'presentation', '演示文稿'], 'ppt'],
  [['excel', 'xlsx', 'spreadsheet', '电子表格', '表格'], 'excel'],
  [['markdown', 'markitdown'], 'markdown'],
  [['pdf'], 'pdf'],
  [['word', 'docx', '文档', '文稿', '公文', 'doc'], 'word'],
  [['stock', '股票', 'akshare', '行情', '量化', 'quant', 'fintech', '金融', '基金'], 'stock'],
  [
    [
      '可视化',
      'visual',
      'chart',
      '图表',
      'dashboard',
      '看板',
      '数据分析',
      'data-analysis',
      'data-insight',
      'insight',
      'analytics'
    ],
    'data'
  ],
  [['research', '研究', '调研', 'deep-research'], 'research'],
  [['browser', '浏览器', 'headless', 'playwright', 'selenium', '网页自动化'], 'browser'],
  [['github', 'gitlab', '代码仓库', 'repo', '仓库', 'pull request', '代码评审'], 'github'],
  [['image', '图片', '图像', 'photo', 'picture', '配图', '海报'], 'image'],
  [['tts', '语音', 'voice', '音频', 'speech', 'podcast', '播客', 'video', '视频', '字幕'], 'media'],
  [['translate', '翻译', 'translation', '多语言'], 'translate'],
  [['reminder', '提醒', 'calendar', '日历', '日程', 'meeting', '会议', 'schedule'], 'calendar'],
  [['mail', '邮件', 'email', '邮箱', 'gmail', 'smtp', 'imap', 'outlook'], 'mail'],
  [
    ['discord', 'slack', 'telegram', '短信', '聊天', '钉钉', 'dingtalk', '飞书', 'lark', 'feishu', '微信', 'wechat'],
    'im'
  ],
  [['memory', '记忆', '记住', 'knowledge'], 'memory'],
  [['search', '搜索', '检索', 'tavily', 'brave', 'crawl', '爬虫', '抓取'], 'search'],
  [['automation', '自动化', 'workflow', '工作流', 'cron', '定时', 'updater'], 'automation'],
  [['desktop', '桌面', '鼠标', '键盘', 'screenshot', '截图'], 'desktop'],
  [['skill-creator', 'skill_creator', '技能创建', 'create-skill', '技能开发'], 'skillcreator'],
  [['password', '密码', '1password', '凭证', 'credential', 'secret', 'vault'], 'password'],
  [['netdisk', '网盘', 'drive', '云盘'], 'netdisk'],
  [['copywriting', '文案', 'marketing', '营销', '广告', 'seo'], 'marketing'],
  [['web', '网页', '网站', 'html', 'frontend', '前端', 'landing'], 'web']
]

const CATEGORY_EXAMPLE_KEYS: Readonly<Record<string, ExampleKey>> = {
  ai: 'cat_ai',
  dev: 'cat_dev',
  efficiency: 'cat_efficiency',
  data: 'cat_data',
  content: 'cat_content',
  security: 'cat_security',
  communication: 'cat_communication'
}

export type ExampleKey =
  | 'ppt'
  | 'excel'
  | 'markdown'
  | 'pdf'
  | 'word'
  | 'stock'
  | 'data'
  | 'research'
  | 'browser'
  | 'github'
  | 'image'
  | 'media'
  | 'translate'
  | 'calendar'
  | 'mail'
  | 'im'
  | 'memory'
  | 'search'
  | 'automation'
  | 'desktop'
  | 'skillcreator'
  | 'password'
  | 'netdisk'
  | 'marketing'
  | 'web'
  | 'cat_ai'
  | 'cat_dev'
  | 'cat_efficiency'
  | 'cat_data'
  | 'cat_content'
  | 'cat_security'
  | 'cat_communication'
  | 'fallback'

export function exampleKeyFor(text: string, category?: string): ExampleKey {
  const haystack = text.toLowerCase()

  for (const [keywords, key] of EXAMPLE_KEYWORDS) {
    if (keywords.some(keyword => haystack.includes(keyword))) {
      return key
    }
  }

  return (category && CATEGORY_EXAMPLE_KEYS[category]) || 'fallback'
}

/** 选出「去试试」要填进输入框的话。guide 是技能自带的使用引导，有就直接用。 */
export function tryPrompt(
  skill: { category?: string; description?: string; name: string },
  examples: (key: ExampleKey, name: string) => string,
  guide?: string | null
): string {
  if (guide?.trim()) {
    return guide.trim()
  }

  const key = exampleKeyFor(`${skill.name} ${skillSlug(skill.name)} ${skill.description ?? ''}`, skill.category)

  return examples(key, skill.name)
}
