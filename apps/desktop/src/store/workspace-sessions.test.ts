import { afterEach, expect, it } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import {
  $workspaceSessionCategories,
  projectBelongsToWorkspace,
  rememberSessionWorkspace,
  sessionWorkspaceCategory
} from './workspace-sessions'

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

it('hides office-only auto projects in code mode while preserving code and explicit projects', () => {
  const officeSession = {
    connection_id: 'local',
    cwd: 'D:/workspace/20261023-141751',
    id: 'office-session',
    profile: 'default'
  } as SessionInfo

  const codeSession = {
    connection_id: 'local',
    cwd: 'D:/repo',
    git_repo_root: 'D:/repo',
    id: 'code-session',
    profile: 'default'
  } as SessionInfo

  rememberSessionWorkspace(officeSession.id, 'work', 'local', 'default')
  rememberSessionWorkspace(codeSession.id, 'codex', 'local', 'default')

  expect(
    projectBelongsToWorkspace({ isAuto: true, previewSessions: [officeSession] }, 'codex', 'local')
  ).toBe(false)
  expect(
    projectBelongsToWorkspace({ isAuto: true, previewSessions: [officeSession] }, 'work', 'local')
  ).toBe(true)
  expect(projectBelongsToWorkspace({ isAuto: true, previewSessions: [codeSession] }, 'codex', 'local')).toBe(true)
  expect(projectBelongsToWorkspace({ previewSessions: [officeSession] }, 'codex', 'local')).toBe(true)
})
