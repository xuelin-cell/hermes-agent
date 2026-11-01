import { Codecs, persistentAtom } from '@/lib/persisted'
import type { SessionInfo } from '@/types/hermes'

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

/** Creation ownership wins over cwd, which can change during a conversation. */
export function sessionWorkspaceCategory(session: SessionInfo, connection?: string): WorkspaceCategory {
  const categories = $workspaceSessionCategories.get()

  for (const id of [session.id, session._lineage_root_id, ...(session._lineage_ids ?? []), session.parent_session_id]) {
    if (!id) {continue}
    const category = categories[sessionKey(id, session.connection_id || connection, session.profile)]

    if (category === 'work' || category === 'codex') {return category}
  }

  // Older versions did not record category. Auto-created office folders are
  // identifiable; only a proven Git repository is migrated to code development.
  const folder = session.cwd?.replace(/\\/g, '/').split('/').pop() ?? ''

  return !/^\d{8}-\d{6}$/.test(folder) && session.git_repo_root ? 'codex' : 'work'
}

export function projectBelongsToWorkspace(
  project: {
    isAuto?: boolean
    isNoProject?: boolean
    previewSessions?: SessionInfo[]
  },
  category: WorkspaceCategory,
  connection?: string
): boolean {
  if (category !== 'codex' || !project.isAuto || project.isNoProject || !project.previewSessions?.length) {
    return true
  }

  return project.previewSessions.some(session => sessionWorkspaceCategory(session, connection) === 'codex')
}
