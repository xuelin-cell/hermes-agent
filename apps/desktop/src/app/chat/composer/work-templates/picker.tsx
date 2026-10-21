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
import { DynamicIcon, type IconName, iconNames } from 'lucide-react/dynamic'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { BarChart3, FileText, type IconComponent, iconSize, Search, X } from '@/lib/icons'
import { $selectedWelcomeModules } from '@/store/workspace-category'

import type { WelcomeCategory } from '../../../../../electron/uniwork-welcome/catalog'

import { $resolvedWelcomeCatalog, loadWelcomeCatalog } from './catalog-store'
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

const SUPPORTED_ICONS = new Set<string>(iconNames)

/** 图标名称只解析为本地 Lucide 图标，不执行远端代码。 */
function CategoryIcon({ category }: { category: WelcomeCategory }) {
  const Icon = (category.icon && ICONS[category.icon]) || ICONS[category.id] || IconSparkles

  if (category.icon && SUPPORTED_ICONS.has(category.icon)) {
    return (
      <DynamicIcon
        className={iconSize.md}
        fallback={() => <Icon className={iconSize.md} />}
        name={category.icon as IconName}
      />
    )
  }

  return <Icon className={iconSize.md} />
}

interface WorkTemplatePickerProps {
  selectionContainer?: HTMLElement | null
  scope: string | null
  disabled: boolean
  onReplaceText: (text: string) => void
}

/** 推荐行在分类和模板之间切换，输入框中的分类 chip 独立保留。 */
export function WorkTemplatePicker({ scope, disabled, onReplaceText, selectionContainer }: WorkTemplatePickerProps) {
  const { locale, t } = useI18n()
  const language = locale.startsWith('zh') ? 'zh-CN' : 'en'
  const catalog = useStore($resolvedWelcomeCatalog[language])
  const module = useStore($selectedWelcomeModules[language])
  const categories = module?.tags ?? []

  const [selection, setSelection] = useState({
    scope,
    language,
    moduleId: module?.id,
    category: null as string | null,
    template: null as string | null
  })

  const category =
    selection.scope === scope && selection.language === language && selection.moduleId === module?.id
      ? (categories.find(item => item.id === selection.category) ?? null)
      : null

  useEffect(() => {
    void loadWelcomeCatalog(language)
  }, [language])
  useEffect(() => {
    setSelection({ scope, language, moduleId: module?.id, category: null, template: null })
  }, [scope, language, module?.id])

  if (!categories.length) {
    return null
  }

  const selectedChip = category && (
    <div data-slot="work-selected-category">
      <span>{category.name}</span>
      <Button
        aria-label={t.composer.workClearCategory}
        disabled={disabled}
        onClick={() => setSelection({ scope, language, moduleId: module?.id, category: null, template: null })}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <X className={iconSize.xs} />
      </Button>
    </div>
  )

  return (
    <section
      aria-label={module?.name ?? t.composer.workTemplates}
      className="mb-2 min-w-0 px-[5px]"
      data-slot="work-template-picker"
    >
      <HorizontalRow
        contentKey={`${module?.id}:${category?.id ?? 'categories'}`}
        leftLabel={t.composer.workScrollLeft}
        rightLabel={t.composer.workScrollRight}
      >
        {category
          ? category.templates.map(template => (
              <Button
                aria-pressed={selection.template === template.id}
                className="rounded-full"
                disabled={disabled || catalog.status === 'loading'}
                key={template.id}
                onClick={() => {
                  setSelection({ scope, language, moduleId: module?.id, category: category.id, template: template.id })
                  onReplaceText(template.prompt)
                }}
                size="sm"
                type="button"
                variant="chip"
              >
                {template.name}
                <IconArrowDownRight className={iconSize.sm} />
              </Button>
            ))
          : categories.map(item => (
              <Button
                className="rounded-full"
                disabled={disabled}
                key={item.id}
                onClick={() => {
                  setSelection({ scope, language, moduleId: module?.id, category: item.id, template: null })
                  onReplaceText('')
                  void loadWelcomeCatalog(language, true)
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
      {selectionContainer ? createPortal(selectedChip, selectionContainer) : selectedChip}
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
