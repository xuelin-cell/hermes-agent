import './workspace-category-tabs.css'

import { useStore } from '@nanostores/react'
import { BookOpen, Monitor, SquareCode } from 'lucide-react'
import { useRef } from 'react'

import { useI18n } from '@/i18n'
import { $workspaceCategory, setWorkspaceCategory } from '@/store/workspace-category'

import { workspaceCategoryCopy } from './workspace-category-copy'

const categories = [
  { id: 'work', icon: Monitor },
  { id: 'code', icon: SquareCode },
  { id: 'life', icon: BookOpen }
] as const

export function WorkspaceCategoryTabs() {
  const category = useStore($workspaceCategory)
  const { locale } = useI18n()
  const copy = workspaceCategoryCopy[locale]
  const ref = useRef<HTMLDivElement>(null)

  return (
    <div className="workspace-category-nav">
      <div aria-label={copy.label} className="workspace-category-tabs" ref={ref} role="tablist">
        {categories.map(({ id, icon: Icon }, index) => (
          <button
            aria-selected={category === id}
            key={id}
            onClick={() => setWorkspaceCategory(id)}
            onKeyDown={event => {
              const targets: Record<string, number> = {
                ArrowRight: (index + 1) % categories.length,
                ArrowLeft: (index + categories.length - 1) % categories.length,
                Home: 0,
                End: categories.length - 1
              }

              const next = targets[event.key]

              if (next === undefined) {
                return
              }

              event.preventDefault()
              setWorkspaceCategory(categories[next].id)
              ref.current?.querySelectorAll('button')[next]?.focus()
            }}
            role="tab"
            tabIndex={category === id ? 0 : -1}
            type="button"
          >
            <Icon aria-hidden="true" size={18} />
            <span>{copy[id]}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
