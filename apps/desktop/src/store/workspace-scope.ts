import { Codecs, persistentAtom } from '@/lib/persisted'

export type WorkspaceCategory = 'work' | 'codex'

/** 场景用于新会话和预览选择；办公、学习和代码开发共用全部场景历史，不按场景筛选。 */
export const $selectedWorkspaceMode = persistentAtom<WorkspaceCategory | null>(
  'uniwork.desktop.workspaceCategory.v1',
  null,
  Codecs.json(value => (value === 'work' || value === 'codex' ? value : null))
)
