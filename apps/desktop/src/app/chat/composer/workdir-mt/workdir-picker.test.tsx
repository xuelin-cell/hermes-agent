import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesGateway } from '@/hermes'
import type * as DesktopFs from '@/lib/desktop-fs'
import { selectDesktopPaths } from '@/lib/desktop-fs'
import type * as Notifications from '@/store/notifications'
import { notify } from '@/store/notifications'
import { $currentCwd, $currentCwdExplicit, $newChatWorkspaceTarget, $sessions, setNewChatWorkspaceTarget } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { WorkdirPicker } from './workdir-picker'

vi.mock('@/lib/desktop-fs', async importOriginal => ({
  ...(await importOriginal<typeof DesktopFs>()),
  selectDesktopPaths: vi.fn()
}))

vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<typeof Notifications>()),
  notify: vi.fn(),
  notifyError: vi.fn()
}))

const DEFAULT = 'C:\\acct\\workspace'

/** 模拟后端：`config.get project` 不带目录时给默认工作区，带目录时原样确认。 */
function fakeGateway() {
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'config.get') {
      return { branch: '', cwd: (params.cwd as string | undefined) ?? DEFAULT }
    }

    throw new Error(`unexpected ${method}`)
  })

  return { gateway: { request } as unknown as HermesGateway, request }
}

const session = (cwd: string, lastActive: number) => ({ cwd, last_active: lastActive }) as SessionInfo

/** Radix 菜单在 jsdom 里靠 pointerdown 打开。 */
function openMenu() {
  fireEvent.pointerDown(screen.getByTestId('workdir-picker'), { button: 0, pointerType: 'mouse' })
}

beforeEach(() => {
  setNewChatWorkspaceTarget(null)
  $currentCwd.set('')
  $currentCwdExplicit.set(false)
  $sessions.set([])
})

afterEach(() => {
  cleanup()
  vi.mocked(selectDesktopPaths).mockReset()
  vi.mocked(notify).mockReset()
})

describe('WorkdirPicker on a new conversation', () => {
  it('starts on the default workspace and points the draft at a picked folder', async () => {
    const { gateway } = fakeGateway()
    vi.mocked(selectDesktopPaths).mockResolvedValue(['D:\\work\\alpha'])

    render(<WorkdirPicker cwd="" gateway={gateway} sessionId={null} />)
    expect(screen.getByTestId('workdir-picker').textContent).toContain('Default workspace')

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Choose another folder/ }))

    await waitFor(() => expect($newChatWorkspaceTarget.get()).toBe('D:\\work\\alpha'))
    expect($currentCwd.get()).toBe('D:\\work\\alpha')
    // 用户主动选择的目录必须优先于 Profile 自己配置的 terminal.cwd（#52589）。
    expect($currentCwdExplicit.get()).toBe(true)
    await waitFor(() => expect(screen.getByTestId('workdir-picker').textContent).toContain('alpha'))
  })

  it('lists recent folders without the default workspace and switches back to default', async () => {
    const { gateway } = fakeGateway()
    $sessions.set([session(DEFAULT, 9), session('D:\\work\\beta', 5), session('D:\\work\\gamma', 7)])

    render(<WorkdirPicker cwd="" gateway={gateway} sessionId={null} />)
    // 等默认工作区路径到达，才能把它从最近列表中排除。
    await waitFor(() => expect(gateway.request).toHaveBeenCalled())
    openMenu()

    await waitFor(() => expect(screen.queryAllByRole('menuitem', { name: /workspace/ })).toHaveLength(1))
    const names = screen.getAllByRole('menuitem').map(item => item.textContent)
    expect(names.findIndex(name => name?.startsWith('gamma'))).toBeLessThan(names.findIndex(name => name?.startsWith('beta')))

    fireEvent.click(screen.getByRole('menuitem', { name: /beta/ }))
    await waitFor(() => expect($newChatWorkspaceTarget.get()).toBe('D:\\work\\beta'))

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Default workspace/ }))
    expect($newChatWorkspaceTarget.get()).toBeNull()
    expect($currentCwd.get()).toBe('')
    expect($currentCwdExplicit.get()).toBe(false)
  })

  it('最近使用不列出默认工作区下自动建的对话文件夹，说明随是否自动建而变', async () => {
    const { gateway } = fakeGateway()
    window.hermesDesktop = { createConversationFolder: vi.fn() } as never
    $sessions.set([session(`${DEFAULT}\\20261019-103015`, 9), session(`${DEFAULT}\\报告`, 5)])

    try {
      render(<WorkdirPicker cwd="" gateway={gateway} sessionId={null} />)
      await waitFor(() => expect(gateway.request).toHaveBeenCalled())
      openMenu()

      await waitFor(() => expect(screen.getByRole('menuitem', { name: /报告/ })).toBeTruthy())
      expect(screen.queryByRole('menuitem', { name: /20261019-103015/ })).toBeNull()
      expect(screen.getByText(/Each new conversation gets its own folder/)).toBeTruthy()
    } finally {
      window.hermesDesktop = undefined as never
    }
  })

  it('没有自动建文件夹的接口时沿用原说明', () => {
    const { gateway } = fakeGateway()

    render(<WorkdirPicker cwd="" gateway={gateway} sessionId={null} />)
    openMenu()

    expect(screen.getByText(/The agent reads and writes files in this folder/)).toBeTruthy()
  })

  it('refuses a home folder and leaves the draft unchanged', async () => {
    const { gateway } = fakeGateway()
    vi.mocked(selectDesktopPaths).mockResolvedValue(['C:\\Users\\stan'])

    render(<WorkdirPicker cwd="" gateway={gateway} sessionId={null} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Choose another folder/ }))

    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' })))
    expect($newChatWorkspaceTarget.get()).toBeNull()
  })

  it('ignores a folder that arrives after the conversation has started', async () => {
    const { gateway, request } = fakeGateway()
    let resolvePick: (paths: string[]) => void = () => undefined
    vi.mocked(selectDesktopPaths).mockReturnValue(new Promise(resolve => (resolvePick = resolve)))

    const { rerender } = render(<WorkdirPicker cwd="" gateway={gateway} sessionId={null} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Choose another folder/ }))

    rerender(<WorkdirPicker cwd={DEFAULT} gateway={gateway} sessionId="runtime-1" />)
    await act(async () => resolvePick(['D:\\work\\late']))

    expect($newChatWorkspaceTarget.get()).toBeNull()
    expect(request).not.toHaveBeenCalledWith('session.cwd.set', expect.anything())
  })
})

describe('WorkdirPicker on a started conversation', () => {
  it('shows the bound folder read-only with the new-conversation hint', async () => {
    const { gateway, request } = fakeGateway()

    render(<WorkdirPicker cwd="D:\work\alpha" gateway={gateway} sessionId="runtime-1" />)
    const trigger = screen.getByTestId('workdir-picker')
    expect(trigger.textContent).toBe('alpha')

    fireEvent.click(trigger)

    expect(await screen.findByText('D:\\work\\alpha')).toBeTruthy()
    expect(screen.getByText(/start a new conversation/)).toBeTruthy()
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    expect(request).not.toHaveBeenCalledWith('session.cwd.set', expect.anything())
  })

  it('自动建的对话文件夹显示文件夹名，点开看完整路径', async () => {
    const { gateway } = fakeGateway()
    const folder = `${DEFAULT}\\20261019-103015`

    render(<WorkdirPicker cwd={folder} gateway={gateway} sessionId="runtime-1" />)
    await waitFor(() => expect(screen.getByTestId('workdir-picker').textContent).toBe('20261019-103015'))

    fireEvent.click(screen.getByTestId('workdir-picker'))
    expect(await screen.findByText(folder)).toBeTruthy()
  })

  it('names the account workspace as the default workspace', async () => {
    const { gateway } = fakeGateway()

    render(<WorkdirPicker cwd={DEFAULT} gateway={gateway} sessionId="runtime-1" />)

    await waitFor(() => expect(screen.getByTestId('workdir-picker').textContent).toBe('Default workspace'))
  })
})
