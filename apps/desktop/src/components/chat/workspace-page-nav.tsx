import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'

import { NEW_CHAT_ROUTE } from '@/app/routes'

import { WorkspaceCategoryTabs } from './workspace-category-tabs'

/** Page routes retain a way back to the selected workspace's chat surface. */
export function WorkspacePageNav({ children }: { children: ReactNode }) {
  const navigate = useNavigate()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceCategoryTabs onSelect={() => void navigate(NEW_CHAT_ROUTE)} />
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  )
}
