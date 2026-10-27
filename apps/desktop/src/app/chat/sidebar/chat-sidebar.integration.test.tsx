// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $welcomeCatalog } from '@/app/chat/composer/work-templates/catalog-store'
import { WorkspaceCategoryTabs } from '@/components/chat/workspace-category-tabs'
import { group, split } from '@/components/pane-shell/tree/model'
import { $layoutTree, noteActiveTreeGroup } from '@/components/pane-shell/tree/store'
import { SidebarProvider } from '@/components/ui/sidebar'
import { registry } from '@/contrib/registry'
import { TRANSLATIONS } from '@/i18n'
import { $connectionsRegistry } from '@/store/connection-registry-state'
import { $developerMode } from '@/store/developer-mode'
import { setInterfaceMode } from '@/store/interface-mode'
import { $sidebarGrouping, $sidebarMessagingOpenIds, setSidebarAgentsGrouped, setSidebarGrouping } from '@/store/layout'
import { $activeGatewayProfile, $profiles, $showAllProfiles, setShowAllProfiles } from '@/store/profile'
import { $profileRailVisible } from '@/store/profile-rail-prefs'
import { $projectScope, ALL_PROJECTS } from '@/store/project-scope'
import { $projectTree } from '@/store/projects'
import {
  $currentCwd,
  $messagingSessions,
  $messagingTruncated,
  $selectedStoredSessionId,
  $sessionProfilesTruncated,
  $sessions,
  $sessionsLoadError,
  $sessionsLoading,
  $workspaceCwdOwner
} from '@/store/session'
import { $removedSessionIds } from '@/store/session-removal'
import { SIDEBAR_NAV_PREFS_AREA } from '@/store/sidebar-nav'
import { $selectedWorkspaceMode } from '@/store/workspace-category'
import { makeSessionInfo } from '@/test/session-info'

import { normalizeWelcomeCatalog } from '../../../../electron/uniwork-welcome/catalog'
import { type AppView, ROUTES_AREA, SIDEBAR_NAV_AREA } from '../../routes'

import { $gatewayGroupCollapsed } from './gateway-group-preferences'

import { ChatSidebar } from './index'

const noop = () => {}

const noopAsync = async () => {}

const sessionRows = [
  makeSessionInfo({ id: 'tile-one', last_active: 2, profile: 'default', started_at: 1, title: 'Tile one' }),
  makeSessionInfo({ id: 'tile-two', last_active: 2, profile: 'default', started_at: 1, title: 'Tile two' })
]

const renderSidebar = (
  pathname: string,
  currentView: AppView,
  onRetrySessions: () => Promise<void> = noopAsync,
  workspaceTabs = false
) =>
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <SidebarProvider>
        {workspaceTabs && <WorkspaceCategoryTabs />}
        <ChatSidebar
          currentView={currentView}
          onArchiveSession={noop}
          onBranchSession={noop}
          onDeleteSession={noop}
          onLoadMoreSessions={noop}
          onManageCronJob={noop}
          onNavigate={noop}
          onNewSessionInWorkspace={noop}
          onNewSessionSplit={noop}
          onResumeSession={noop}
          onRetrySessions={onRetrySessions}
          onTriggerCronJob={noopAsync}
        />
      </SidebarProvider>
    </MemoryRouter>
  )

const currentButtons = () =>
  screen.queryAllByRole('button').filter(button => button.classList.contains('bg-(--ui-control-active-background)'))

const expectOnlyCurrent = (label: string | null) => {
  const button = label ? screen.getByRole('button', { name: label }) : null

  expect(currentButtons()).toEqual(button ? [button] : [])
}

const expectOnlySelectedSession = (title: string | null) => {
  const rows = ['Tile one', 'Tile two']
    .map(label => screen.queryByText(label)?.closest('.group.row-hover'))
    .filter(row => row !== undefined)

  const selectedRows = rows.filter(row => row?.className.includes('bg-(--ui-row-active-background)'))
  const expected = title ? [screen.getByText(title).closest('.group.row-hover')] : []

  expect(selectedRows).toEqual(expected)
}

const focus = (groupId: null | string) => act(() => noteActiveTreeGroup(groupId))

describe('ChatSidebar navigation activity', () => {
  let disposeContributions: () => void

  it('switches the real sidebar with named workspace tabs while keeping session history', () => {
    setSidebarGrouping('date')
    $projectTree.set([
      {
        id: '__no_project__',
        label: 'Home',
        path: null,
        repos: [],
        sessionCount: 1,
        isNoProject: true,
        previewSessions: [sessionRows[1]]
      },
      {
        id: 'example',
        label: 'workspace-project',
        path: '/repos/example',
        repos: [],
        sessionCount: 1,
        previewSessions: [
          makeSessionInfo({ ...sessionRows[0], cwd: '/repos/example', git_repo_root: '/repos/example', pinned: true })
        ]
      }
    ])
    $sessions.set([
      makeSessionInfo({ ...sessionRows[0], cwd: '/repos/example', git_repo_root: '/repos/example', pinned: true }),
      sessionRows[1]
    ])
    $welcomeCatalog.set({
      ...$welcomeCatalog.get(),
      en: {
        status: 'ready',
        modules: normalizeWelcomeCatalog({
          modules: [
            { name: '日常办公' },
            { name: '代码开发', workspace: 'codex', enabled: false },
            { name: '学习生活' }
          ]
        })
      }
    })
    const view = renderSidebar('/', 'chat', noopAsync, true)
    fireEvent.click(screen.getByRole('tab', { name: '日常办公' }))
    expect(screen.queryByText('workspace-project')).toBeNull()
    expect(screen.getByRole('button', { name: TRANSLATIONS.en.sidebar.nav.artifacts })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '代码开发' }))
    expect(screen.getByText('workspace-project')).toBeTruthy()
    expect(screen.getByText('Projects')).toBeTruthy()
    expect(view.container.querySelector('[data-code-project="__no_project__"]')).toBeNull()
    expect(screen.queryByText('Tile two')).toBeNull()
    const projectGroup = screen.getByText('workspace-project').closest('[data-code-project]') as HTMLElement
    expect(within(projectGroup).getByText('Tile one')).toBeTruthy()
    expect(screen.getAllByText('Tile one')).toHaveLength(1)
    fireEvent.click(within(projectGroup).getByRole('button', { expanded: true }))
    expect(screen.queryByText('Tile one')).toBeNull()
    fireEvent.click(within(projectGroup).getByRole('button', { expanded: false }))
    expect(within(projectGroup).getByText('Tile one')).toBeTruthy()
    expect($sidebarGrouping.get()).toBe('date')
    expect(screen.queryByRole('button', { name: TRANSLATIONS.en.sidebar.nav.artifacts })).toBeNull()
    expect(screen.queryByRole('button', { name: TRANSLATIONS.en.sidebar.nav.cron })).toBeNull()
    expect([...view.container.querySelectorAll('[data-tour^="sidebar-nav-"]')].map(node => node.textContent)).toEqual([
      TRANSLATIONS.en.sidebar.nav['new-session'],
      TRANSLATIONS.en.workspaceEditor.title,
      [TRANSLATIONS.en.skills.tabSkills, TRANSLATIONS.en.skills.tabPlugins, TRANSLATIONS.en.connectorsPage.title].join(
        ' · '
      )
    ])
    const tree = $projectTree.get()
    act(() => $projectTree.set(tree.filter(project => project.isNoProject)))
    expect(view.container.querySelector('[data-code-project]')).toBeNull()
    expect(screen.queryByText('Tile two')).toBeNull()
    act(() => $projectTree.set(tree))
    fireEvent.click(screen.getByRole('tab', { name: '学习生活' }))
    expect(screen.queryByText('workspace-project')).toBeNull()
    expect($sidebarGrouping.get()).toBe('date')
    expect(screen.getByRole('button', { name: TRANSLATIONS.en.sidebar.nav.artifacts })).toBeTruthy()
    expect(screen.queryByText('Tile one')).toBeNull()
    expect(screen.getByText('Tile two')).toBeTruthy()
    expect(screen.getByRole('button', { name: TRANSLATIONS.en.sidebar.nav.cron })).toBeTruthy()
    cleanup()
    setInterfaceMode('advanced')
  })

  beforeEach(() => {
    $developerMode.set(false)
    disposeContributions = registry.registerMany([
      { area: ROUTES_AREA, id: 'kanban-page', data: { path: '/kanban' }, render: () => null },
      { area: ROUTES_AREA, id: 'reports-page', data: { path: '/reports' }, render: () => null },
      { area: SIDEBAR_NAV_AREA, id: 'kanban-nav', data: { codicon: 'project', label: 'Kanban', path: '/kanban' } },
      { area: SIDEBAR_NAV_AREA, id: 'reports-nav', data: { codicon: 'graph', label: 'Reports', path: '/reports' } }
    ])
    $selectedStoredSessionId.set('tile-one')
    $sessions.set(sessionRows)
    $removedSessionIds.set(new Set())
    $layoutTree.set(
      split('row', [
        group(['workspace'], { active: 'workspace', id: 'workspace-group' }),
        group(['session-tile:tile-one'], { active: 'session-tile:tile-one', id: 'tile-one-group' }),
        group(['session-tile:tile-two'], { active: 'session-tile:tile-two', id: 'tile-two-group' })
      ])
    )
    noteActiveTreeGroup('workspace-group')
  })

  afterEach(() => {
    cleanup()
    $activeGatewayProfile.set('default')
    setShowAllProfiles(false)
    $selectedWorkspaceMode.set(null)
    $projectTree.set([])
    setInterfaceMode('advanced')
    disposeContributions()
    $selectedStoredSessionId.set(null)
    $sessions.set([])
    $sessionProfilesTruncated.set({})
    $removedSessionIds.set(new Set())
    $layoutTree.set(null)
    noteActiveTreeGroup(null)
    $developerMode.set(false)
    $profileRailVisible.set(false)
  })

  it('only shows profile and gateway controls in developer mode', () => {
    $profileRailVisible.set(true)
    const view = renderSidebar('/chat', 'chat')

    expect(view.container.querySelector('[data-slot="profile-rail"]')).toBeNull()

    act(() => $developerMode.set(true))

    expect(view.container.querySelector('[data-slot="profile-rail"]')).not.toBeNull()
  })

  it('切换专家后仍显示通用助手和其他专家历史，同时保留工作模式筛选', () => {
    setShowAllProfiles(false)
    setSidebarGrouping('date')
    setSidebarAgentsGrouped(false)
    $selectedWorkspaceMode.set('work')
    $sessionsLoading.set(false)
    $sessionProfilesTruncated.set({ default: false, 'expert-a': false, 'expert-b': true })
    $sessions.set([
      ...sessionRows,
      makeSessionInfo({ id: 'expert-a-chat', profile: 'expert-a', title: 'Expert A history' }),
      makeSessionInfo({ id: 'expert-b-chat', profile: 'expert-b', title: 'Expert B history' }),
      makeSessionInfo({
        id: 'code-chat',
        profile: 'expert-a',
        title: 'Code history',
        cwd: '/repo',
        git_repo_root: '/repo'
      })
    ])
    renderSidebar('/', 'chat')

    for (const profile of ['expert-a', 'expert-b', 'default']) {
      act(() => $activeGatewayProfile.set(profile))
      expect(screen.getByText('Tile one')).toBeTruthy()
      expect(screen.getByText('Tile two')).toBeTruthy()
      expect(screen.getByText('Expert A history')).toBeTruthy()
      expect(screen.getByText('Expert B history')).toBeTruthy()
      expect(screen.queryByText('Code history')).toBeNull()
      expect(screen.getByRole('button', { name: TRANSLATIONS.en.sidebar.loadMore })).toBeTruthy()
      expect($activeGatewayProfile.get()).toBe(profile)
      expect($selectedStoredSessionId.get()).toBe('tile-one')
      expect($showAllProfiles.get()).toBe(false)
    }
  })

  it('keeps navigation and session activity coherent with the focused pane', () => {
    renderSidebar('/kanban', 'extension')
    expectOnlyCurrent('Kanban')
    expectOnlySelectedSession(null)

    focus('tile-one-group')
    expectOnlyCurrent(null)
    expectOnlySelectedSession('Tile one')

    focus('tile-two-group')
    expectOnlyCurrent(null)
    expectOnlySelectedSession('Tile two')

    focus(null)
    expectOnlyCurrent('Kanban')
    expectOnlySelectedSession(null)

    focus('tile-two-group')
    act(() => {
      $removedSessionIds.set(new Set(['tile-two']))
      $sessions.set([sessionRows[0]])
    })
    expectOnlyCurrent(null)
    expectOnlySelectedSession(null)

    act(() => {
      $removedSessionIds.set(new Set())
      $sessions.set(sessionRows)
    })

    for (const [pathname, currentView, label] of [
      [
        '/capabilities',
        'capabilities',
        ['Experts', TRANSLATIONS.en.skills.tabSkills, TRANSLATIONS.en.connectorsPage.title].join(' · ')
      ],
      ['/messaging', 'messaging', 'Messaging'],
      ['/artifacts', 'artifacts', TRANSLATIONS.en.sidebar.nav.artifacts],
      ['/cron', 'cron', 'Scheduled jobs']
    ] as const) {
      cleanup()
      focus('workspace-group')
      renderSidebar(pathname, currentView)
      expectOnlyCurrent(label)
      expectOnlySelectedSession(null)

      focus('tile-one-group')
      expectOnlyCurrent(null)
      expectOnlySelectedSession('Tile one')
    }

    cleanup()
    focus('workspace-group')
    renderSidebar('/reports', 'extension')
    expectOnlyCurrent('Reports')

    cleanup()
    disposeContributions()
    disposeContributions = noop
    focus('workspace-group')
    renderSidebar('/kanban', 'extension')
    expect(screen.queryByRole('button', { name: 'Kanban' })).toBeNull()
    expectOnlyCurrent(null)
    expectOnlySelectedSession(null)
  })

  // Teardown proof: the loader disposes a plugin's contributions on disable,
  // and that disposer alone must bring the row back — no store to clear.
  it('hides a nav row while a sidebarNav.prefs contribution is registered and restores it on dispose', () => {
    renderSidebar('/kanban', 'extension')
    expect(screen.getByRole('button', { name: 'Kanban' })).toBeTruthy()

    let dispose = () => {}

    act(() => {
      dispose = registry.register({ area: SIDEBAR_NAV_PREFS_AREA, id: 'prefs', data: { hide: ['kanban-nav'] } })
    })
    expect(screen.queryByRole('button', { name: 'Kanban' })).toBeNull()
    // A hidden row is a preference, not a removal: the sibling nav row stays.
    expect(screen.getByRole('button', { name: 'Reports' })).toBeTruthy()

    act(() => dispose())
    expect(screen.getByRole('button', { name: 'Kanban' })).toBeTruthy()
  })
})

// #67600: a cold-start read that failed used to render as an empty account.
describe('ChatSidebar cold-start load failure', () => {
  afterEach(() => {
    cleanup()
    setInterfaceMode('advanced')
    $sessions.set([])
    $sessionsLoading.set(true)
    $sessionsLoadError.set(false)
  })

  it('offers retry in place of the empty state', () => {
    const retry = vi.fn(noopAsync)
    $sessions.set([])
    $sessionsLoading.set(false)
    $sessionsLoadError.set(true)

    renderSidebar('/', 'chat', retry)

    expect(screen.getByText('Could not load sessions')).toBeTruthy()
    expect(screen.queryByText('No sessions yet')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })
})

// Entering a project is a scope switch: the conversation main is showing keeps
// its workspace, so Files/Review and the composer's Git context can't drift to
// the project while the transcript stays on the old chat (#72772).
describe('ChatSidebar project entry', () => {
  const project = {
    id: '/repos/new-project',
    label: 'new-project',
    path: '/repos/new-project',
    repos: [],
    sessionCount: 0
  }

  beforeEach(() => {
    setSidebarAgentsGrouped(true)
    $projectTree.set([project])
    $currentCwd.set('/repos/old-project')
  })

  afterEach(() => {
    cleanup()
    setInterfaceMode('advanced')
    $projectScope.set(ALL_PROJECTS)
    $projectTree.set([])
    setSidebarAgentsGrouped(false)
    $currentCwd.set('')
    $selectedStoredSessionId.set(null)
    $workspaceCwdOwner.set(null)
    $sessions.set([])
  })

  it("leaves a stored conversation's workspace alone", () => {
    $sessions.set(sessionRows)
    $selectedStoredSessionId.set('tile-one')
    $workspaceCwdOwner.set('tile-one')
    $projectScope.set(project.id)

    renderSidebar('/tile-one', 'chat')

    expect($currentCwd.get()).toBe('/repos/old-project')
    expect($workspaceCwdOwner.get()).toBe('tile-one')
  })

  it('re-homes a fresh draft into the entered project', () => {
    $projectScope.set(project.id)

    renderSidebar('/', 'chat')

    expect($currentCwd.get()).toBe(project.path)
  })
})

// Messaging platforms group rows by owner the same way recents does once every
// profile is on screen, so a Telegram thread is attributable to its profile
// (#87715). The platform's row cap and load-more stay the section's.
describe('ChatSidebar section labels', () => {
  const realProject = {
    id: '/repos/new-project',
    label: 'new-project',
    path: '/repos/new-project',
    repos: [],
    sessionCount: 0
  }

  // The synthetic Home bucket the backend emits when no project claimed a
  // session (no cwd / deleted workspace): one lane, no repo structure.
  const homeOnly = [
    {
      ...realProject,
      id: '__no_project__',
      label: 'Home',
      path: null,
      isNoProject: true,
      sessionCount: 2
    }
  ]

  afterEach(() => {
    cleanup()
    setInterfaceMode('advanced')
    $projectScope.set(ALL_PROJECTS)
    $projectTree.set([])
    setSidebarAgentsGrouped(false)
    $sessions.set([])
  })

  it('labels the section "Projects" when the grouped tree has a real project', () => {
    setSidebarAgentsGrouped(true)
    $projectTree.set([realProject])

    renderSidebar('/', 'chat')

    expect(screen.getByText('Projects')).toBeTruthy()
    expect(screen.queryByText('Sessions')).toBeNull()
  })

  it('keeps the "Sessions" label when grouping is on but no projects exist', () => {
    // The source-filter toggle with an empty tree: the section lists plain
    // chat sessions, so heading it "Projects" mislabeled them (#62537).
    setSidebarAgentsGrouped(true)
    $projectTree.set([])
    $sessions.set(sessionRows)

    renderSidebar('/', 'chat')

    expect(screen.getByText('Sessions')).toBeTruthy()
    expect(screen.queryByText('Projects')).toBeNull()
  })

  it('keeps the "Sessions" label when the grouped tree is only the synthetic Home bucket', () => {
    // No real projects — every session fell into Home. A lone Home bucket is
    // the flat session list wearing a project costume, not a switcher.
    setSidebarAgentsGrouped(true)
    $projectTree.set(homeOnly)
    $sessions.set(sessionRows)

    renderSidebar('/', 'chat')

    expect(screen.getByText('Sessions')).toBeTruthy()
    expect(screen.queryByText('Projects')).toBeNull()
  })
})

describe('ChatSidebar empty-profile sections', () => {
  // A profile with no normal sessions but messaging threads / cron jobs must
  // still show them: the session area (and the sections inside it) is gated by
  // showSessionSections, which used to key only on normal-session visibility
  // and collapsed these profiles to the blank state (#63593).
  const telegramThread = (id: string, last_active: number) =>
    makeSessionInfo({ connection_id: 'local', id, last_active, profile: 'default', source: 'telegram', title: id })

  beforeEach(() => {
    $connectionsRegistry.set({
      version: 2,
      primary: 'local',
      secureTokenStorage: true,
      connections: [{ id: 'local', label: 'This computer', kind: 'local', tokenSet: false, tokenPreview: null }]
    } as NonNullable<typeof $connectionsRegistry.value>)
    $profiles.set([{ name: 'default', is_default: true }] as typeof $profiles.value)
    $sessions.set([])
    $messagingSessions.set([telegramThread('tg-one', 60), telegramThread('tg-two', 30)])
    $messagingTruncated.set(false)
    $sidebarMessagingOpenIds.set(['telegram'])
    $sessionsLoading.set(false)
  })

  afterEach(() => {
    cleanup()
    setInterfaceMode('advanced')
    $messagingSessions.set([])
    $sidebarMessagingOpenIds.set([])
    $sessions.set([])
  })

  it('shows the messaging section for a profile with no normal sessions', () => {
    const { container } = renderSidebar('/', 'chat')

    // The Telegram platform section renders with its threads…
    expect(screen.getAllByText('Telegram').length).toBeGreaterThan(0)
    expect(screen.getByText('tg-one')).toBeTruthy()
    // …and the sidebar did not collapse to the blank state: the search field
    // only renders inside the session area, so its presence proves the area
    // (and the messaging sections inside it) rendered.
    expect(screen.getByPlaceholderText('Search sessions…')).toBeTruthy()
  })

  it('still shows the blank state when a profile has nothing at all', () => {
    $messagingSessions.set([])
    $sidebarMessagingOpenIds.set([])

    // SidebarBlankState: a centered "No sessions yet" plus a "New project"
    // button, rendered INSTEAD of the whole session area (search included).
    const { container } = renderSidebar('/', 'chat')

    expect(container.textContent).toContain('No sessions yet')
    expect(screen.queryByPlaceholderText('Search sessions…')).toBeNull()
  })

  it('shows RCS history in its own collapsible platform section beside local chats and WeChat', () => {
    $sessions.set([makeSessionInfo({ id: 'local-chat', source: 'desktop', title: 'Local conversation' })])
    $messagingSessions.set([
      makeSessionInfo({
        id: 'rcs-history',
        connection_id: 'local',
        profile: 'default',
        source: 'uniagentgate',
        title: 'RCS history'
      }),
      makeSessionInfo({
        id: 'wechat-history',
        connection_id: 'local',
        profile: 'default',
        source: 'weixin',
        title: 'WeChat history'
      })
    ])
    $sidebarMessagingOpenIds.set(['uniagentgate', 'weixin'])
    renderSidebar('/', 'chat')
    const section = screen.getByText('5G 消息').closest('[data-slot="sidebar-group"]')!
    expect(within(section as HTMLElement).getByText('RCS history')).toBeTruthy()
    expect(within(section as HTMLElement).queryByText('Local conversation')).toBeNull()
    expect(within(section as HTMLElement).queryByText('WeChat history')).toBeNull()
    expect(screen.getAllByText('WeChat').length).toBeGreaterThan(0)
    expect(screen.getByText('Local conversation')).toBeTruthy()
    fireEvent.click(within(section as HTMLElement).getByRole('button', { name: '5G 消息' }))
    expect(within(section as HTMLElement).queryByText('RCS history')).toBeNull()
    expect(screen.getByText('WeChat history')).toBeTruthy()
  })
})

describe('ChatSidebar messaging owners', () => {
  const telegram = (id: string, profile: string, last_active: number) =>
    makeSessionInfo({ connection_id: 'local', id, last_active, profile, source: 'telegram', title: id })

  // Newest first: the 3-row cap lets default-1, work-1 and default-2 through.
  const threads = [
    telegram('default-1', 'default', 50),
    telegram('work-1', 'work', 40),
    telegram('default-2', 'default', 30),
    telegram('work-2', 'work', 20),
    telegram('default-3', 'default', 10)
  ]

  let root: HTMLElement

  const mount = () => {
    root = renderSidebar('/', 'chat').container
  }

  const telegramGroups = () =>
    [...root.querySelectorAll<HTMLElement>('[data-gateway-group]')].filter(node =>
      node.dataset.gatewayGroup!.startsWith(JSON.stringify(['messaging:telegram']).slice(0, -1))
    )

  const titlesIn = (node: HTMLElement) =>
    threads.map(thread => thread.id).filter(title => within(node).queryByText(title))

  beforeEach(() => {
    $connectionsRegistry.set({
      version: 2,
      primary: 'local',
      secureTokenStorage: true,
      connections: [{ id: 'local', label: 'This computer', kind: 'local', tokenSet: false, tokenPreview: null }]
    } as NonNullable<typeof $connectionsRegistry.value>)
    $profiles.set([
      { name: 'default', is_default: true },
      { name: 'work', is_default: false }
    ] as typeof $profiles.value)
    $sessions.set([
      makeSessionInfo({ connection_id: 'local', id: 'desk', last_active: 60, profile: 'default', title: 'desk' })
    ])
    $messagingSessions.set(threads)
    $messagingTruncated.set(false)
    $sidebarMessagingOpenIds.set(['telegram'])
  })

  afterEach(() => {
    cleanup()
    setInterfaceMode('advanced')
    setSidebarGrouping('date')
    setShowAllProfiles(false)
    $activeGatewayProfile.set('default')
    $gatewayGroupCollapsed.set([])
    $sidebarMessagingOpenIds.set([])
    $messagingSessions.set([])
    $sessions.set([])
    $profiles.set([])
    $connectionsRegistry.set(null)
  })

  it('groups the capped rows by owner, pages the platform as a whole, and keeps its own collapse keys', () => {
    setSidebarGrouping('profile')
    mount()

    const [defaultGroup, workGroup] = telegramGroups()

    expect(telegramGroups()).toHaveLength(2)
    expect(titlesIn(defaultGroup)).toEqual(['default-1', 'default-2'])
    expect(titlesIn(workGroup)).toEqual(['work-1'])

    fireEvent.click(screen.getByRole('button', { name: 'Load 2 more' }))

    expect(titlesIn(telegramGroups()[0])).toEqual(['default-1', 'default-2', 'default-3'])
    expect(titlesIn(telegramGroups()[1])).toEqual(['work-1', 'work-2'])
    expect(screen.queryByRole('button', { name: /^Load \d+ more$/ })).toBeNull()

    fireEvent.click(within(telegramGroups()[0]).getByRole('button', { name: 'Hide default sessions' }))

    expect(screen.queryByText('default-1')).toBeNull()
    expect(screen.getByText('desk')).toBeTruthy()
  })

  it('tags rows with their profile under other groupings and stays flat when scoped to one profile', () => {
    setShowAllProfiles(true)
    setSidebarGrouping('date')
    mount()

    const row = (title: string) => screen.getByText(title).closest('.group.row-hover') as HTMLElement

    expect(telegramGroups()).toHaveLength(0)
    expect(within(row('work-1')).getByRole('img', { name: 'Profile: work' })).toBeTruthy()

    cleanup()
    setSidebarGrouping('profile')
    setShowAllProfiles(false)
    mount()

    expect(telegramGroups()).toHaveLength(0)
    expect(screen.queryByText('work-1')).toBeNull()
    expect(within(row('default-1')).queryByRole('img', { name: /^Profile:/ })).toBeNull()
  })
})
