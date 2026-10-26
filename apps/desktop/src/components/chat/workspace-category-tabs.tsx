import './workspace-category-tabs.css'

import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

import { $resolvedWelcomeCatalog, loadWelcomeCatalog } from '@/app/chat/composer/work-templates/catalog-store'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { $interfaceMode } from '@/store/interface-mode'
import { $selectedWelcomeModules, selectWorkspaceModule } from '@/store/workspace-category'

import { WelcomeIcon } from './welcome-icon'
import { workspaceCategoryCopy } from './workspace-category-copy'

interface WorkspaceCategoryTabsProps {
  onSelect?: () => void
}

export function WorkspaceCategoryTabs({ onSelect }: WorkspaceCategoryTabsProps = {}) {
  const { locale, t } = useI18n()
  const language = locale.startsWith('zh') ? 'zh-CN' : 'en'
  const { modules, status } = useStore($resolvedWelcomeCatalog[language])
  const selected = useStore($selectedWelcomeModules[language])
  const mode = useStore($interfaceMode)
  const copy = workspaceCategoryCopy[locale]
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadWelcomeCatalog(language)
  }, [language])
  useEffect(() => {
    if (selected) {
      selectWorkspaceModule(language, selected)
    }
  }, [language, selected, mode])

  if (!modules.length) {
    return status === 'loading' ? null : (
      <div className="workspace-category-nav">
        <Button onClick={() => void loadWelcomeCatalog(language, true)} size="sm" type="button" variant="text">
          {t.composer.workRetry}
        </Button>
      </div>
    )
  }

  return (
    <div className="workspace-category-nav">
      <div aria-label={copy.label} className="workspace-category-tabs" ref={ref} role="tablist">
        {modules.map((module, index) => {
          return (
            <button
              aria-selected={selected?.id === module.id}
              key={module.id}
              onClick={() => {
                selectWorkspaceModule(language, module)
                onSelect?.()
              }}
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
                const ownerDocument = ref.current?.ownerDocument

                selectWorkspaceModule(language, modules[next])
                ref.current?.querySelectorAll('button')[next]?.focus()
                onSelect?.()
                requestAnimationFrame(() => {
                  const tabs = ownerDocument?.querySelectorAll<HTMLButtonElement>(
                    '.workspace-category-tabs button[aria-selected="true"]'
                  )

                  Array.from(tabs ?? [])
                    .find(tab => tab.getClientRects().length > 0)
                    ?.focus()
                })
              }}
              role="tab"
              tabIndex={selected?.id === module.id ? 0 : -1}
              type="button"
            >
              <WelcomeIcon name={module.icon} size={18} />
              <span>{module.name}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
