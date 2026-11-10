import { Codecs, persistentAtom } from '@/lib/persisted'

import { $interfaceMode } from './interface-mode'
import { $selectedWorkspaceMode, type WorkspaceCategory } from './workspace-scope'

export const $workspaceSessionCategories = persistentAtom<Record<string, string>>(
  'uniwork.desktop.sessionWorkspace.v1',
  {},
  Codecs.stringRecord
)

export function currentWorkspaceCategory(): WorkspaceCategory {
  return $selectedWorkspaceMode.get() ?? ($interfaceMode.get() === 'advanced' ? 'codex' : 'work')
}

function sessionKey(id: string, connection = 'local', profile = 'default'): string {
  return JSON.stringify([connection, profile, id])
}

export function rememberSessionWorkspace(
  id: string,
  category: WorkspaceCategory,
  connection?: string,
  profile?: string
) {
  const key = sessionKey(id, connection, profile)

  if ($workspaceSessionCategories.get()[key] !== category) {
    $workspaceSessionCategories.set({ ...$workspaceSessionCategories.get(), [key]: category })
  }
}
