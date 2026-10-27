import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ROUTES_AREA } from '@/app/routes'
import { registry } from '@/contrib/registry'
import type * as HermesApi from '@/hermes'
import { registerPluginLocales } from '@/i18n/plugin-i18n'
import { KITS_LOCALES } from '@/plugins/uniwork-kits/i18n'
import { KitsPage } from '@/plugins/uniwork-kits/page'
import type { ExpertDirectory, KitRow } from '@/plugins/uniwork-kits/types'
import { $developerMode } from '@/store/developer-mode'
import { $selectedWorkspaceMode } from '@/store/workspace-category'

import { CapabilitiesView } from '../index'

const catalog = vi.hoisted(() => vi.fn())
const summon = vi.hoisted(() => vi.fn())

let releaseRoute = () => {}
const originalWorkspaceMode = $selectedWorkspaceMode.get()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getSkills: async () => [],
  getToolsets: async () => [],
  getProfiles: async () => ({ profiles: [{ name: 'default', is_default: true }] }),
  getOfficialSkills: async () => ({ skills: [] })
}))

vi.mock('@/plugins/uniwork-kits/api', () => ({
  fetchCatalog: catalog,
  openAuthorization: vi.fn(),
  toggleKit: vi.fn(),
  writeConfig: vi.fn()
}))
vi.mock('@/plugins/uniwork-kits/bundled', () => ({
  $bundled: atom({ running: false }),
  $bundledFinished: atom(false),
  watchBundled: vi.fn()
}))
vi.mock('@/plugins/uniwork-kits/experts-store', () => ({
  $expertDirectory: atom<ExpertDirectory>({ experts: [], recent: [] }),
  loadExperts: vi.fn()
}))
vi.mock('@/plugins/uniwork-kits/expert-face', () => ({ ExpertFace: () => null }))
vi.mock('@/plugins/uniwork-kits/summon', () => ({ summonExpert: summon }))
vi.mock('./skills-hub', () => ({ SkillsHub: () => <div>Skill catalog</div> }))

function row(name: string, kind: string): KitRow {
  return {
    name,
    kind,
    display_name: name,
    profession: '',
    description: name + ' description',
    phrases: [],
    version: '1',
    enabled: true,
    profile: kind === 'expert' ? name : '',
    self: false,
    market_id: '',
    skill_count: 1,
    agent_count: 0,
    mcp_count: 0,
    user_config: [],
    missing_secrets: [],
    oauth_servers: [],
    pending_triggers: 0,
    unverified_triggers: 0
  }
}

function Extensions() {
  const location = useLocation()

  return (
    <>
      <output data-testid="location">{location.pathname + location.search}</output>
      <CapabilitiesView />
    </>
  )
}

async function mount(path: string) {
  $developerMode.set(false)
  $selectedWorkspaceMode.set('work')
  releaseRoute = registry.register({
    id: 'expert-catalog-test',
    area: ROUTES_AREA,
    data: { path: '/kits' },
    render: () => <KitsPage />
  })
  registerPluginLocales('uniwork-kits', KITS_LOCALES)
  catalog.mockResolvedValue({
    plugins: [row('Writer expert', 'expert'), row('Finance expert', 'expert'), row('Office kit', 'kit')]
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<KitsPage />} path="/kits" />
            <Route element={<Extensions />} path="/capabilities" />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  })

  return client
}

afterEach(() => {
  cleanup()
  releaseRoute()
  $selectedWorkspaceMode.set(originalWorkspaceMode)
  vi.clearAllMocks()
})

describe('Extensions expert and kit shelves', () => {
  it('keeps experts inside Extensions, filters each shelf, and preserves summon actions', async () => {
    const client = await mount('/capabilities')
    fireEvent.click(screen.getByRole('button', { name: 'Experts' }))
    expect(await screen.findByText('Writer expert')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Experts/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByText('Office kit')).toBeNull()
    expect(screen.getByTestId('location').textContent).toBe('/capabilities?tab=experts')

    fireEvent.change(screen.getByRole('textbox', { name: 'Search experts' }), { target: { value: 'Writer' } })
    await waitFor(() => expect(screen.queryByText('Finance expert')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Summon' }))
    expect(summon).toHaveBeenCalledWith(expect.objectContaining({ name: 'Writer expert' }))

    fireEvent.click(screen.getByRole('tab', { name: /^Kits/ }))
    expect(await screen.findByText('Office kit')).toBeTruthy()
    expect(screen.queryByText('Writer expert')).toBeNull()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Search kits' }).value).toBe('')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search kits' }), { target: { value: 'absent' } })
    await waitFor(() => expect(screen.queryByText('Office kit')).toBeNull())
    expect(screen.getByTestId('location').textContent).toContain('/capabilities?')
    client.clear()
  })

  it('restores old kits links into the kit shelf under Extensions', async () => {
    const client = await mount('/kits')
    expect(await screen.findByText('Office kit')).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe('/capabilities?tab=experts&shelf=kits')
    expect(screen.getByRole('button', { name: 'Experts' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('tab', { name: /^Kits/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('button', { name: 'Connectors' })).toBeTruthy()
    client.clear()
  })
})
