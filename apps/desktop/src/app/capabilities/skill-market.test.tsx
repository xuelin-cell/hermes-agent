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
    tags: ['文档', '办公']
  }
])

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getUniWorkRecommendedCategories: getRecommendedCategories,
  getUniWorkRecommendedSkills: getRecommendedSkills
}))

const { SkillMarket } = await import('./skill-market')

afterEach(() => cleanup())

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
    expect(screen.getByText('UniWork')).toBeTruthy()
    expect(screen.getByText('文档')).toBeTruthy()
  })
})
