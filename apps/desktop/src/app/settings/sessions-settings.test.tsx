// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listAllProfileSessions, setSessionArchived } from '@/hermes'
import { en } from '@/i18n/en'
import { notify } from '@/store/notifications'
import {
  $messagingSessions,
  $sessions,
  getConfiguredDefaultProjectDir,
  setMessagingSessions,
  setSessions,
  syncConfiguredDefaultProjectDir
} from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { SessionsSettings } from './sessions-settings'

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: en }) }))

vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notify: vi.fn()
}))

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
  const workspace = 'C:/uniwork/acc/workspace'

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

    expect(await screen.findByText(workspace)).toBeTruthy()
    expect(screen.getByText(/each new conversation gets its own folder/)).toBeTruthy()
    expect(screen.queryByText(en.settings.sessions.defaultDirDesc)).toBeNull()
  })

  it.each(['Restart now', 'Later', 'already active'])('保存后按需重启：%s', async choice => {
    mountBridge(true)
    const settings = window.hermesDesktop!.settings
    const next = 'D:/work'
    Object.assign(settings, {
      getDefaultProjectDir: async () => ({ dir: next, activeRoot: workspace, defaultLabel: workspace }),
      pickDefaultProjectDir: vi.fn(async () => ({ dir: next })),
      setDefaultProjectDir: async () => ({
        dir: next,
        activeRoot: workspace,
        restartRequired: choice !== 'already active'
      }),
      restartForDefaultProjectDir: vi.fn()
    })
    await syncConfiguredDefaultProjectDir()
    render(<SessionsSettings subpage="default-directory" />)
    fireEvent.click(await screen.findByRole('button', { name: en.settings.sessions.change }))
    await waitFor(() => expect(settings.pickDefaultProjectDir).toHaveBeenCalled())
    expect(getConfiguredDefaultProjectDir()).toBe('')

    if (choice === 'already active') {
      expect(screen.queryByRole('dialog')).toBeNull()
    } else {
      expect(screen.getByRole('dialog').textContent).toContain(next)
      expect(screen.getByRole('dialog').textContent).toContain(workspace)
      await act(async () => fireEvent.click(screen.getByRole('button', { name: choice })))
    }

    expect(settings.restartForDefaultProjectDir).toHaveBeenCalledTimes(choice === 'Restart now' ? 1 : 0)
  })

  it('选的位置不可用时提示实际目录，不保存也不提示重启', async () => {
    mountBridge(true)
    const settings = window.hermesDesktop!.settings
    const saved = 'D:/saved'
    Object.assign(settings, {
      getDefaultProjectDir: async () => ({ dir: saved, activeRoot: saved, defaultLabel: workspace }),
      pickDefaultProjectDir: async () => ({ dir: 'E:/readonly' }),
      setDefaultProjectDir: async () => ({ dir: saved, activeRoot: saved, restartRequired: false, unusable: true })
    })
    render(<SessionsSettings subpage="default-directory" />)
    fireEvent.click(await screen.findByRole('button', { name: en.settings.sessions.change }))
    await waitFor(() => expect(notify).toHaveBeenCalled())
    const { message } = vi.mocked(notify).mock.lastCall![0]
    expect(message).toContain('E:/readonly')
    expect(message).toContain(saved)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getAllByText(saved).length).toBeGreaterThan(0)
  })

  it('已保存的位置启动时不可用，页面一直显示实际目录，改选后消失', async () => {
    mountBridge(true)
    const settings = window.hermesDesktop!.settings
    const saved = 'E:/readonly'
    Object.assign(settings, {
      getDefaultProjectDir: async () => ({
        dir: saved,
        activeRoot: workspace,
        defaultLabel: workspace,
        unusable: true
      }),
      pickDefaultProjectDir: async () => ({ dir: 'D:/work' }),
      setDefaultProjectDir: async () => ({ dir: 'D:/work', activeRoot: workspace, restartRequired: true })
    })
    render(<SessionsSettings subpage="default-directory" />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(saved)
    expect(alert.textContent).toContain(workspace)
    fireEvent.click(screen.getByRole('button', { name: en.settings.sessions.change }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('没有对话文件夹接口时保留原说明', async () => {
    mountBridge(false)
    render(<SessionsSettings subpage="default-directory" />)

    expect(await screen.findByText(workspace)).toBeTruthy()
    expect(screen.getByText(en.settings.sessions.defaultDirDesc)).toBeTruthy()
  })
})

it('renders only archived conversations for the data-management page even with a stale directory link', async () => {
  render(<SessionsSettings onlyArchived subpage="default-directory" />)
  expect(await screen.findByRole('button', { name: en.settings.sessions.unarchive })).toBeTruthy()
  expect(screen.queryByText(en.settings.sessions.defaultDirTitle)).toBeNull()
  expect(screen.queryByRole('switch', { name: en.settings.sessions.autoArchiveTitle })).toBeNull()
})
