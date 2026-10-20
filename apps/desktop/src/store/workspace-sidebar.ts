import { computed } from 'nanostores'

import { $sidebarGrouping } from '@/store/layout'
import { $selectedWorkspaceMode } from '@/store/workspace-category'

/** Workspace navigation changes the rendered grouping, never the user's saved preference. */
export const $workspaceSidebarGrouping = computed([$selectedWorkspaceMode, $sidebarGrouping], (workspace, grouping) => {
  if (workspace === 'codex') {
    return 'project'
  }

  return workspace === 'work' && grouping === 'project' ? 'date' : grouping
})
