// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import type { SkillInfo } from '@/types/hermes'

// 真实目录的样子：显示名「中文（短名）」；装好后的技能名取自 SKILL.md，可能和短名不同。
const marketSkills = [
  {
    id: 'tushare-finance',
    name: '中国金融行情数据（tushare-finance）',
    description: '金融数据',
    download_url: 'https://wry-manatee-359.convex.site/api/v1/download?slug=tushare-finance'
  },
  {
    id: 'brainstorming-v2',
    name: '头脑风暴（brainstorming-v2）',
    description: '头脑风暴',
    download_url: 'https://skillhub-1388575217.cos.accelerate.myqcloud.com/skills/brainstorming-v2/1.0.0.zip'
  }
]

const installUniWorkSkill = vi.fn()
const api = vi.fn()
const RECORDS_PATH = '/api/skills/hub/search?q=e&source=official&limit=1'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getUniWorkMarketCategories: vi.fn().mockResolvedValue([]),
  getUniWorkMarketSkills: vi.fn().mockResolvedValue(marketSkills),
  getUniWorkRecommendedCategories: vi.fn().mockResolvedValue([]),
  getUniWorkRecommendedSkills: vi.fn().mockResolvedValue([]),
  installUniWorkSkill: (...args: unknown[]) => installUniWorkSkill(...args)
}))

vi.mock('@/store/hub-actions', () => ({ installHubSkill: vi.fn(), uninstallHubSkill: vi.fn() }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

const { SkillsHub } = await import('./skills-hub')
const { SkillMarket } = await import('../skill-market')

const hubSkill = (name: string): SkillInfo => ({
  category: 'general',
  description: '',
  enabled: true,
  name,
  provenance: 'hub'
})

function records(installed: Record<string, string>) {
  return {
    results: [],
    source_counts: {},
    timed_out: [],
    installed: Object.fromEntries(
      Object.entries(installed).map(([id, name]) => [id, { name, trust_level: 'community', scan_verdict: 'safe' }])
    )
  }
}

function renderHub(skills: SkillInfo[], installedPending = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const ui = (list: SkillInfo[]) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SkillsHub
          hiddenKitSkills={0}
          installedError={null}
          installedNames={new Set(list.map(skill => skill.name))}
          installedPending={installedPending}
          onRefresh={() => undefined}
          query=""
          skills={list}
        />
      </MemoryRouter>
    </QueryClientProvider>
  )

  const view = render(ui(skills))

  return { rerenderWith: (list: SkillInfo[]) => view.rerender(ui(list)) }
}

async function marketCard(name: string) {
  fireEvent.click(screen.getByRole('tab', { name: 'Skill Market' }))

  const title = await screen.findByText(name)

  return title.closest('.mt-skills-card') as HTMLElement
}

beforeEach(() => {
  Object.assign(window, { hermesDesktop: { api } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  Reflect.deleteProperty(window, 'hermesDesktop')
  delete window.document.documentElement.dataset.hermesBrowser
})

describe('skill market installed state', () => {
  it('marks cards installed from the install record and the market id, not the display name', async () => {
    api.mockResolvedValue(records({ 'brainstorming-v2': 'brainstorming' }))
    renderHub([hubSkill('brainstorming'), hubSkill('tushare-finance')])

    const brainstorm = await marketCard('头脑风暴（brainstorming-v2）')

    await waitFor(() => expect(within(brainstorm).getByRole('button', { name: 'Try it' })).toBeTruthy())
    expect(
      within(
        screen.getByText('中国金融行情数据（tushare-finance）').closest('.mt-skills-card') as HTMLElement
      ).getByRole('button', { name: 'Try it' })
    ).toBeTruthy()
    expect(api).toHaveBeenCalledWith(expect.objectContaining({ path: RECORDS_PATH }))
  })

  it('flips the card as soon as the install returns, and does not install it twice', async () => {
    api.mockResolvedValue(records({}))
    installUniWorkSkill.mockResolvedValue({ ok: true, name: 'brainstorming', install_path: 'brainstorming' })

    const view = renderHub([])
    const card = await marketCard('头脑风暴（brainstorming-v2）')

    fireEvent.click(within(card).getByRole('button', { name: 'Add to my skills' }))
    await waitFor(() => expect(installUniWorkSkill).toHaveBeenCalledTimes(1))

    // 技能列表刷新后带上新技能；安装记录接口这时还没有它，靠安装接口返回的名字。
    view.rerenderWith([hubSkill('brainstorming')])
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Try it' })).toBeTruthy())
    expect(within(card).queryByRole('button', { name: 'Add to my skills' })).toBeNull()
  })

  it('waits for the installed list before installing', async () => {
    renderHub([], true)

    const card = await marketCard('中国金融行情数据（tushare-finance）')

    fireEvent.click(within(card).getByRole('button', { name: 'Add to my skills' }))
    expect(installUniWorkSkill).not.toHaveBeenCalled()
  })

  it('only queries instance install records when the cloud persistence bridge is available', async () => {
    renderHub([{ ...hubSkill('pdf'), provenance: 'bundled' }])
    await marketCard('中国金融行情数据（tushare-finance）')
    expect(api).not.toHaveBeenCalled()
    cleanup()

    window.document.documentElement.dataset.hermesBrowser = '1'
    renderHub([hubSkill('tushare-finance')])
    await marketCard('中国金融行情数据（tushare-finance）')
    expect(api).not.toHaveBeenCalled()
    cleanup()
    Object.assign(window.hermesDesktop, { cloudSkillOperations: { mutate: vi.fn() } })
    api.mockResolvedValue(records({ 'tushare-finance': 'tushare-finance' }))
    renderHub([hubSkill('tushare-finance')])
    await marketCard('中国金融行情数据（tushare-finance）')
    await waitFor(() => expect(api).toHaveBeenCalled())
  })

  it('uses the same check on the developer-mode market page', async () => {
    api.mockResolvedValue(records({ 'brainstorming-v2': 'brainstorming' }))

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SkillMarket installed={null} installedCount={1} installedNames={new Set(['brainstorming'])} />
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Skill Market' }))

    const card = (await screen.findByRole('heading', { name: '头脑风暴（brainstorming-v2）' })).closest(
      'article'
    ) as HTMLElement

    await waitFor(() => expect(within(card).getByRole('button', { name: 'Installed' })).toBeTruthy())
    expect(
      within(
        screen.getByRole('heading', { name: '中国金融行情数据（tushare-finance）' }).closest('article') as HTMLElement
      ).getByRole('button', { name: 'Install' })
    ).toBeTruthy()
  })
})
