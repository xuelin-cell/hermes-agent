// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'

const getRecommendedCategories = vi.fn().mockResolvedValue([{ id: 'office', name: '办公效率' }])

const getRecommendedSkills = vi.fn().mockResolvedValue([
  {
    id: 'writer',
    name: '智能写作',
    description: '帮助整理和撰写办公文档',
    category: 'office',
    provider: 'UniWork',
    tags: ['文档', '办公'],
    package_download_path: '/uniwork/skills/writer/package'
  }
])
const installUniWorkSkill = vi.fn().mockResolvedValue({ ok: true, name: 'office-writer', install_path: 'office-writer' })
const installHubSkill = vi.fn().mockResolvedValue(undefined)
const notify = vi.fn()
const notifyError = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getUniWorkRecommendedCategories: getRecommendedCategories,
  getUniWorkRecommendedSkills: getRecommendedSkills,
  installUniWorkSkill
}))

vi.mock('@/store/hub-actions', () => ({ installHubSkill }))
vi.mock('@/store/notifications', () => ({ notify, notifyError }))

const { SkillMarket } = await import('./skill-market')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SkillMarket', () => {
  it('推荐技能使用与已安装技能一致的目录卡片外观', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={client}>
        <SkillMarket installed={<div>installed</div>} installedCount={0} installedNames={new Set()} />
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Recommended' }))

    const title = await screen.findByRole('heading', { name: '智能写作' })
    const card = title.closest('article')

    expect(card?.hasAttribute('data-catalog-card')).toBe(true)
    expect(card?.className).toContain('--catalog-accent')
    expect(card?.className).not.toContain('min-h-48')
    expect(card?.closest('[data-slot="masonry"]')).toBeTruthy()
    expect(screen.getByText('UniWork')).toBeTruthy()
    expect(screen.getByText('文档')).toBeTruthy()
  })

  it('点击安装会调用市场安装接口并等待完成', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <SkillMarket installed={<div>installed</div>} installedCount={0} installedNames={new Set()} />
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Recommended' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))

    await vi.waitFor(() => expect(installUniWorkSkill).toHaveBeenCalledWith(expect.objectContaining({ id: 'writer' }), undefined))
  })

  it('市场技能同时提供页面和下载地址时直接安装下载包', async () => {
    getRecommendedSkills.mockResolvedValueOnce([
      {
        id: '1password',
        name: '密码管家（1password）',
        description: 'fixture',
        clawhub_url: 'https://clawhub.ai/steipete/1password',
        download_url: 'https://wry-manatee-359.convex.site/api/v1/download?slug=1password'
      }
    ])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <SkillMarket installed={<div>installed</div>} installedCount={0} installedNames={new Set()} />
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Recommended' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))

    await vi.waitFor(() =>
      expect(installUniWorkSkill).toHaveBeenCalledWith(expect.objectContaining({ id: '1password' }), undefined)
    )
    expect(installHubSkill).not.toHaveBeenCalled()
  })

  it('安装接口返回未完成时不会显示成功提示', async () => {
    installUniWorkSkill.mockResolvedValueOnce({ ok: false, name: '', install_path: '' })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <SkillMarket installed={<div>installed</div>} installedCount={0} installedNames={new Set()} />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Recommended' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))

    await vi.waitFor(() => expect(notifyError).toHaveBeenCalled())
    expect(notify).not.toHaveBeenCalled()
  })
})
