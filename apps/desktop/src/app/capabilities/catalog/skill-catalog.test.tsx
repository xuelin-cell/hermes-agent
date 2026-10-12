// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { parseCatalog } from './catalog-data'

vi.mock('@/hermes', async original => ({
  ...(await original<object>()),
  getOfficialSkills: vi.fn().mockResolvedValue({ skills: [] })
}))
vi.mock('./catalog-browser', () => ({
  // 用不同标识的同名目录条目验证真实安装管理组件的关联行为。
  CatalogBrowser: (props: { renderInstalledAction: (entry: unknown) => unknown }) =>
    props.renderInstalledAction(parseCatalog('skills', [{
      name: 'api-gateway', source: 'ClawHub', identifier: 'api-proxy'
    }])[0])
}))

const { SkillCatalog } = await import('./skill-catalog')
afterEach(() => cleanup())

it('目录标识不同的同名技能仍可操作本地启用状态', () => {
  const toggle = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const skill = { name: 'api-gateway', category: 'general', description: 'installed', enabled: true, provenance: 'agent' as const }
  render(
    <QueryClientProvider client={client}>
      <SkillCatalog
        profile={undefined}
        skills={[skill]}
        renderInstalledDetail={() => null}
        renderInstalledAction={installed => (
          <button onClick={() => toggle(installed.name, !installed.enabled)}>toggle</button>
        )}
      />
    </QueryClientProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
  expect(toggle).toHaveBeenCalledWith('api-gateway', false)
})
