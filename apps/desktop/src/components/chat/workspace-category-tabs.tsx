import './workspace-category-tabs.css'

import { useStore } from '@nanostores/react'
import { BookOpen, Monitor, SquareCode } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { $welcomeCatalog, loadWelcomeCatalog } from '@/app/chat/composer/work-templates/catalog-store'
import { useI18n } from '@/i18n'
import { $interfaceMode } from '@/store/interface-mode'
import { $selectedWelcomeModules, selectWorkspaceModule } from '@/store/workspace-category'

import { workspaceCategoryCopy } from './workspace-category-copy'

export function WorkspaceCategoryTabs() {
  const { locale } = useI18n()
  const language = locale.startsWith('zh') ? 'zh-CN' : 'en'
  const { modules } = useStore($welcomeCatalog)[language]
  const selected = useStore($selectedWelcomeModules[language])
  const mode = useStore($interfaceMode)
  const copy = workspaceCategoryCopy[locale]
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadWelcomeCatalog(language)
  }, [language])
  useEffect(() => {
    if (selected && (selected.workspace === 'codex' ? 'advanced' : 'simple') !== mode) {
      selectWorkspaceModule(language, selected)
    }
  }, [language, selected, mode])

  if (!modules.length) {
    return null
  }

  return (
    <div className="workspace-category-nav">
      <div aria-label={copy.label} className="workspace-category-tabs" ref={ref} role="tablist">
        {modules.map((module, index) => {
          const Icon = module.workspace === 'codex' ? SquareCode : index === 0 ? Monitor : BookOpen

          return (
            <button
              aria-selected={selected?.id === module.id}
              key={module.id}
              onClick={() => selectWorkspaceModule(language, module)}
              onKeyDown={event => {
                const targets: Record<string, number> = {
                  ArrowRight: (index + 1) % modules.length,
                  ArrowLeft: (index + modules.length - 1) % modules.length,
                  Home: 0,
                  End: modules.length - 1
                }

                const next = targets[event.key]

                if (next === undefined) {
                  return
                }

                event.preventDefault()
                selectWorkspaceModule(language, modules[next])
                ref.current?.querySelectorAll('button')[next]?.focus()
              }}
              role="tab"
              tabIndex={selected?.id === module.id ? 0 : -1}
              type="button"
            >
              <Icon aria-hidden="true" size={18} />
              <span>{module.name}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
