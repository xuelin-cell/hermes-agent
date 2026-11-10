import { cleanup, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $selectedStoredSessionId } from '@/store/session'

import { APP_ROUTES, isOverlayView } from '../routes'

import { ChatRoutesSurface } from './surfaces'
import type { WiringActions } from './types'

vi.mock('@/contrib/react/use-contributions', () => ({ useContributions: vi.fn() }))
vi.mock('@/store/connections', () => ({ $activeConnectionId: atom('local') }))
vi.mock('@/store/gateway', () => ({ $gateway: atom<unknown>(null) }))
vi.mock('@/store/profile', () => ({ $activeGatewayProfile: atom('default') }))
vi.mock('@/store/session', () => ({
  $selectedStoredSessionId: atom<string | null>(null),
  $freshDraftReady: atom(false),
  $gatewayState: atom('open')
}))
vi.mock('../chat', () => ({ ChatView: () => <div data-testid="chat-view" /> }))
vi.mock('@/components/chat/workspace-category-tabs', () => ({
  WorkspaceCategoryTabs: () => <div aria-label="Workspace categories" role="tablist" />
}))
vi.mock('../capabilities', () => ({ CapabilitiesView: () => null }))
vi.mock('../messaging', () => ({ MessagingView: () => null }))
vi.mock('../artifacts', () => ({ ArtifactsView: () => null }))
vi.mock('../chat/sidebar', () => ({ ChatSidebar: () => null }))
vi.mock('../right-sidebar/terminal/chrome', () => ({ TerminalPaneChrome: () => null }))
vi.mock('../shell/hooks/use-status-snapshot', () => ({ useStatusSnapshot: () => ({}) }))
vi.mock('../shell/hooks/use-statusbar-items', () => ({
  useStatusbarItems: () => ({ leftStatusbarItems: [], statusbarItems: [] })
}))
vi.mock('../shell/statusbar-controls', () => ({ StatusbarControls: () => null }))
vi.mock('./latest-actions', () => ({ latestChatActions: () => ({}), latestSidebarActions: () => ({}) }))
vi.mock('./panes', () => ({ setStatusbarItemGroup: vi.fn(), useStatusbarContributions: () => [] }))
vi.mock('../shell/model-menu-panel', () => ({ ModelMenuPanel: () => null }))
// desktop-mt: 路由夹具同时隔离普通菜单与开发者菜单，不改变路由断言。
vi.mock('../chat/composer/model-mt/model-list', () => ({ ComposerModelList: () => null }))
vi.mock('../shell/reasoning-menu-panel', () => ({ ReasoningMenuPanel: () => null }))

afterEach(() => {
  cleanup()
  $selectedStoredSessionId.set(null)
})

// The route table (`APP_ROUTES`) and the `<Route>` list are kept by hand in two
// files. A workspace page whose path is missing from the `<Route>` list matches
// `:sessionId`, so the app opens a chat for a session named after the page.
// Overlays are exempt: they are modal cards over whatever the shell shows.
describe('ChatRoutesSurface and APP_ROUTES', () => {
  const pages = APP_ROUTES.filter(route => route.id !== 'editor' && route.view !== 'chat' && !isOverlayView(route.view))

  it.each(pages.map(route => [route.path]))('%s has its own route and never opens as a session', path => {
    const actions = { getGateway: () => null } as unknown as WiringActions

    render(
      <MemoryRouter initialEntries={[path]}>
        <ChatRoutesSurface actions={actions} />
      </MemoryRouter>
    )

    expect(screen.queryByTestId('chat-view')).toBeNull()
    expect(screen.queryByRole('tablist', { name: 'Workspace categories' })).toBeNull()
  })
})

/** 在真实路由中观察旧地址恢复的落点。 */
function RouteLocation() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

it.each([null, 'existing-chat'])('restores the retired editor to its existing chat or draft: %s', selected => {
  $selectedStoredSessionId.set(selected)
  render(
    <MemoryRouter initialEntries={['/editor']}>
      <ChatRoutesSurface actions={{ getGateway: () => null } as unknown as WiringActions} />
      <RouteLocation />
    </MemoryRouter>
  )
  expect(screen.getByTestId('chat-view')).toBeTruthy()
  expect(screen.getByTestId('location').textContent).toBe(selected ? `/${selected}` : '/')
})
