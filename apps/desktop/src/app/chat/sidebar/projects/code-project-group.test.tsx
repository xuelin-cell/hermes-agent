import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { $sidebarWorkspaceNodeOpen } from '@/store/layout'
import type * as ProjectsStore from '@/store/projects'
import { makeSessionInfo } from '@/test/session-info'

import { CodeProjectGroup } from './code-project-group'
import type { SidebarProjectTree } from './workspace-groups'

const { fetchProjectSessions } = vi.hoisted(() => ({ fetchProjectSessions: vi.fn() }))
vi.mock('@/store/projects', async importOriginal => ({
  ...(await importOriginal<typeof ProjectsStore>()),
  fetchProjectSessions,
  projectProfile: () => 'default'
}))
vi.mock('./project-menu', () => ({ ProjectContextMenu: ({ children }: { children: ReactNode }) => children }))

afterEach(() => {
  cleanup()
  $sidebarWorkspaceNodeOpen.set({})
  fetchProjectSessions.mockReset()
})

const project = (id: string, count: number): SidebarProjectTree => ({
  id,
  label: `Project ${id}`,
  path: `/repos/${id}`,
  repos: [],
  sessionCount: count
})

const sessions = Array.from({ length: 5 }, (_, i) => makeSessionInfo({ id: `s${i}`, title: `Chat ${i}` }))

it('shows multiple project conversations inline, toggles only that project, and starts sessions in its folder', () => {
  const enter = vi.fn()
  const start = vi.fn()
  const resume = vi.fn()

  const rows = (items: typeof sessions) =>
    items.map(item => (
      <button key={item.id} onClick={() => resume(item.id)}>
        {item.title}
      </button>
    ))

  const { container } = render(
    <>
      <CodeProjectGroup
        onEnter={enter}
        onNewSession={start}
        previewSessions={sessions}
        project={project('A', 5)}
        renderRows={rows}
      />
      <CodeProjectGroup
        previewSessions={[makeSessionInfo({ id: 'b', title: 'Other chat' })]}
        project={project('B', 1)}
        renderRows={rows}
      />
    </>
  )

  expect(screen.getByRole('button', { name: 'Chat 4' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Chat 4' }))
  expect(resume).toHaveBeenCalledWith('s4')
  const a = container.querySelector('[data-code-project="A"]')!
  fireEvent.click(within(a as HTMLElement).getByRole('button', { expanded: true }))
  expect(screen.queryByRole('button', { name: 'Chat 0' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Other chat' })).toBeTruthy()
  expect(enter).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'New session in Project A' }))
  expect(start).toHaveBeenCalledWith('/repos/A')
  fireEvent.click(within(a as HTMLElement).getByRole('button', { expanded: false }))
  expect(screen.getByRole('button', { name: 'Chat 4' })).toBeTruthy()
})

it('hydrates incomplete project previews in place instead of navigating into a project', async () => {
  const tree = project('A', 5)
  fetchProjectSessions.mockResolvedValue({
    ...tree,
    repos: [
      {
        id: 'repo',
        path: tree.path,
        label: 'repo',
        sessionCount: 5,
        groups: [{ id: 'main', label: 'main', path: tree.path, sessions }]
      }
    ]
  })
  const enter = vi.fn()
  render(
    <CodeProjectGroup
      onEnter={enter}
      previewSessions={sessions.slice(0, 3)}
      project={tree}
      renderRows={items => items.map(item => <span key={item.id}>{item.title}</span>)}
    />
  )
  await waitFor(() => expect(screen.getByText('Chat 4')).toBeTruthy())
  expect(fetchProjectSessions).toHaveBeenCalledWith('A', { supersedable: false })
  expect(enter).not.toHaveBeenCalled()
})
