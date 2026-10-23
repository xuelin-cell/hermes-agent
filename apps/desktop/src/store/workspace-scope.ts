import { Codecs, persistentAtom } from '@/lib/persisted'

export type WorkspaceCategory = 'work' | 'codex'

/** Office and study intentionally share one conversation/preview scope. */
export const $selectedWorkspaceMode = persistentAtom<WorkspaceCategory | null>(
  'uniwork.desktop.workspaceCategory.v1',
  null,
  Codecs.json(value => (value === 'work' || value === 'codex' ? value : null))
)
