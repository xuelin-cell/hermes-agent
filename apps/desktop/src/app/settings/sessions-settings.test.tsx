// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listAllProfileSessions, setSessionArchived } from '@/hermes'
import { en } from '@/i18n/en'
import { $messagingSessions, $sessions, setMessagingSessions, setSessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { SessionsSettings } from './sessions-settings'

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: en }) }))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getHermesConfigRecord: vi.fn().mockResolvedValue({ config: {} }),
  listAllProfileSessions: vi.fn(),
  setSessionArchived: vi.fn().mockResolvedValue(undefined)
}))

const archivedMatrixSession = {
  archived: true,
  ended_at: null,
  id: 'matrix-1',
  input_tokens: 0,
  is_active: false,
  last_active: 1,
  message_count: 2,
  model: null,
  output_tokens: 0,
  preview: null,
  source: 'matrix',
  started_at: 1,
  title: 'archived room',
  tool_call_count: 0
} as SessionInfo

beforeEach(() => {
  setSessions([])
  setMessagingSessions([])
  vi.mocked(listAllProfileSessions).mockResolvedValue({ sessions: [archivedMatrixSession], total: 1 } as never)
})

afterEach(() => {
  cleanup()
})

describe('SessionsSettings unarchive', () => {
  it('restores a messaging-source session into $messagingSessions, not $sessions', async () => {
    render(<SessionsSettings />)
    const button = await screen.findByRole('button', { name: en.settings.sessions.unarchive })

    await act(async () => fireEvent.click(button))

    await waitFor(() => expect(setSessionArchived).toHaveBeenCalledWith('matrix-1', false, undefined))
    expect($messagingSessions.get().map(session => session.id)).toEqual(['matrix-1'])
    expect($messagingSessions.get()[0]?.archived).toBe(false)
    expect($sessions.get()).toEqual([])
  })
})

describe('SessionsSettings default directory (desktop-mt)', () => {
  const bridge = window.hermesDesktop
  const workspace = 'C:/hmt/acc/workspace'

  /** 只提供设置页读取默认目录所需的桥接，可选是否带对话文件夹接口。 */
  function mountBridge(withFolders: boolean) {
    window.hermesDesktop = {
      ...(withFolders ? { createConversationFolder: vi.fn() } : {}),
      settings: {
        getDefaultProjectDir: vi.fn(async () => ({ defaultLabel: workspace, dir: null, resolvedCwd: workspace }))
      }
    } as never
  }

  afterEach(() => {
    window.hermesDesktop = bridge
  })

  it('账号环境说明未设置时使用账号工作区并为每个新对话建文件夹', async () => {
    mountBridge(true)
    render(<SessionsSettings subpage="default-directory" />)

    expect(await screen.findByText(en.settings.sessions.defaultsTo(workspace))).toBeTruthy()
    expect(screen.getByText(/each new conversation gets its own folder/)).toBeTruthy()
    expect(screen.queryByText(en.settings.sessions.defaultDirDesc)).toBeNull()
  })

  it('没有对话文件夹接口时保留原说明', async () => {
    mountBridge(false)
    render(<SessionsSettings subpage="default-directory" />)

    expect(await screen.findByText(en.settings.sessions.defaultsTo(workspace))).toBeTruthy()
    expect(screen.getByText(en.settings.sessions.defaultDirDesc)).toBeTruthy()
  })
})
