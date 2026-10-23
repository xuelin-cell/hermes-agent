import { afterEach, expect, it } from 'vitest'
import type { SessionInfo } from '@/types/hermes'
import { $workspaceSessionCategories, rememberSessionWorkspace, sessionWorkspaceCategory } from './workspace-sessions'

afterEach(() => $workspaceSessionCategories.set({}))

it('keeps creation ownership across cwd changes, compression and backend scopes', () => {
  rememberSessionWorkspace('one', 'work', 'local', 'default')
  rememberSessionWorkspace('one', 'codex', 'remote', 'default')
  const session = { id: 'tip', _lineage_ids: ['one'], git_repo_root: 'D:/Code/example' } as SessionInfo
  expect(sessionWorkspaceCategory(session, 'local')).toBe('work')
  expect(sessionWorkspaceCategory(session, 'remote')).toBe('codex')
})

it('migrates legacy office folders separately from proven code projects', () => {
  const session = { id: 'legacy', git_repo_root: 'D:/Code/example', cwd: 'D:/Code/example' } as SessionInfo
  expect(sessionWorkspaceCategory(session)).toBe('codex')
  expect(sessionWorkspaceCategory({ ...session, cwd: 'D:/workspace/20261023-141751' })).toBe('work')
  expect(sessionWorkspaceCategory({ ...session, git_repo_root: null })).toBe('work')
})
