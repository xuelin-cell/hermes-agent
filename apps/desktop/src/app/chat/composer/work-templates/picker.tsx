import { useStore } from '@nanostores/react'
import {
  IconArrowDownRight,
  IconBuildingBank,
  IconClipboardList,
  IconMoodSmile,
  IconPencil,
  IconPresentation,
  IconSparkles,
  IconTelescope,
  IconVideo
} from '@tabler/icons-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { BarChart3, FileText, type IconComponent, iconSize, Search, X } from '@/lib/icons'

import type { WelcomeCategory } from '../../../../../electron/uniwork-welcome/catalog'

import { $welcomeCatalog, loadWelcomeCatalog } from './catalog-store'
import { HorizontalRow } from './horizontal-row'

const ICONS: Record<string, IconComponent> = {
  'document-processing': FileText,
  presentations: IconPresentation,
  copywriting: IconPencil,
  'data-analysis': BarChart3,
  'meeting-minutes': IconClipboardList,
  'deep-research': IconTelescope,
  'video-search': Search,
  'financial-planning': IconBuildingBank,
  'lifestyle-entertainment': IconMoodSmile,
  'file-text': FileText,
  presentation: IconPresentation,
  'pen-line': IconPencil,
  'bar-chart-3': BarChart3,
  'clipboard-list': IconClipboardList,
  telescope: IconTelescope,
  landmark: IconBuildingBank,
  smile: IconMoodSmile,
  video: IconVideo
}

/** 服务端图标只匹配本地已安装的组件，不动态执行目录提供的代码。 */
function CategoryIcon({ category }: { category: WelcomeCategory }) {
  const Icon = (category.icon && ICONS[category.icon]) || ICONS[category.id] || IconSparkles

  return <Icon className={iconSize.md} />
}

interface WorkTemplatePickerProps {
  scope: string | null
  disabled: boolean
  onReplaceText: (text: string) => void
}

/** 完整办公入口：选分类进入模板、模板回填草稿、取消分类保留已填内容。 */
export function WorkTemplatePicker({ scope, disabled, onReplaceText }: WorkTemplatePickerProps) {
  const { locale, t } = useI18n()
  const language = locale.startsWith('zh') ? 'zh-CN' : 'en'
  const catalog = useStore($welcomeCatalog)[language]

  const [selection, setSelection] = useState({
    scope,
    language,
    category: null as string | null,
    template: null as string | null
  })

  const category =
    selection.scope === scope && selection.language === language
      ? (catalog.categories.find(item => item.id === selection.category) ?? null)
      : null

  useEffect(() => {
    void loadWelcomeCatalog(language)
  }, [language])
  useEffect(() => {
    setSelection({ scope, language, category: null, template: null })
  }, [scope, language])

  if (!catalog.categories.length) {
    return null
  }

  const key = category
    ? `${category.id}:${category.templates.map(item => item.id).join('|')}`
    : catalog.categories.map(item => item.id).join('|')

  return (
    <section data-slot="work-template-picker" aria-label={t.composer.workTemplates} className="mb-2 min-w-0 px-[5px]">
      <HorizontalRow contentKey={key} leftLabel={t.composer.workScrollLeft} rightLabel={t.composer.workScrollRight}>
        {category
          ? category.templates.map(template => (
              <Button
                aria-pressed={selection.template === template.id}
                className="rounded-full aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                disabled={disabled}
                key={template.id}
                onClick={() => {
                  setSelection({ scope, language, category: category.id, template: template.id })
                  onReplaceText(template.prompt)
                }}
                size="sm"
                title={template.prompt}
                type="button"
                variant="chip"
              >
                {template.name}
                <IconArrowDownRight className={iconSize.sm} />
              </Button>
            ))
          : catalog.categories.map(item => (
              <Button
                className="rounded-full"
                disabled={disabled}
                key={item.id}
                onClick={() => {
                  setSelection({ scope, language, category: item.id, template: null })
                  onReplaceText('')
                }}
                size="sm"
                type="button"
                variant="chip"
              >
                <CategoryIcon category={item} />
                {item.name}
              </Button>
            ))}
      </HorizontalRow>
      {category && (
        <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <CategoryIcon category={category} />
          <span>{category.name}</span>
          <Button
            aria-label={t.composer.workClearCategory}
            disabled={disabled}
            onClick={() => setSelection({ scope, language, category: null, template: null })}
            size="icon-xs"
            title={t.composer.workClearCategory}
            type="button"
            variant="ghost"
          >
            <X className={iconSize.xs} />
          </Button>
        </div>
      )}
      {catalog.status === 'cached' && (
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t.composer.workCached}</span>
          <Button
            disabled={disabled}
            onClick={() => void loadWelcomeCatalog(language, true)}
            size="micro"
            type="button"
            variant="text"
          >
            {t.composer.workRetry}
          </Button>
        </div>
      )}
    </section>
  )
}
