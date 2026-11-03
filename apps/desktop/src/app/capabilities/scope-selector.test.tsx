import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { queryClient } from '@/lib/query-client'

import { CAPABILITY_SCOPE_AREA } from './scope-contrib'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProfiles: vi.fn(async () => ({
    profiles: [
      { is_default: true, name: 'default' },
      { is_default: false, name: 'fund-diagnostician' },
      { is_default: false, name: 'coder' }
    ]
  }))
}))
vi.mock('@/store/profile', () => ({
  $activeGatewayProfile: atom('fund-diagnostician'),
  normalizeProfileKey: (name?: null | string) => (name ?? '').trim() || 'default'
}))
vi.mock('@/store/gateway', () => ({ activeGatewayConnectionId: () => 'local' }))

const { useCapabilityScope } = await import('./scope-selector')

afterEach(() => {
  cleanup()
  queryClient.clear()
})

/** 用真实的查询客户端，只替换档案列表接口。 */
function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

it('插件托管的专家档案不在「正在配置」里出现，从专家对话打开时默认配置通用助手', async () => {
  const dispose = registry.register({
    area: CAPABILITY_SCOPE_AREA,
    data: { hideProfiles: ['fund-diagnostician'] },
    id: 'test:managed-profiles',
    source: 'plugin:test'
  })

  try {
    const { result } = renderHook(() => useCapabilityScope({}), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.options.map(option => option.value)).toEqual(['default', 'coder']))
    expect(result.current.value).toBe('default')
  } finally {
    dispose()
  }
})

it('云端连接器可选择专家，离开连接器页后恢复托管档案的配置边界', async () => {
  const dispose = registry.register({ area: CAPABILITY_SCOPE_AREA,
    data: { hideProfiles: ['fund-diagnostician'] }, id: 'test:expert-connectors', source: 'plugin:test' })
  try {
    const { result, rerender } = renderHook(props => useCapabilityScope(props), {
      wrapper: Wrapper, initialProps: { includeManagedProfiles: true, requestedProfile: 'fund-diagnostician' as string | undefined }
    })
    await waitFor(() => expect(result.current.options.some(option => option.value === 'fund-diagnostician')).toBe(true))
    expect(result.current.value).toBe('fund-diagnostician')
    rerender({ includeManagedProfiles: false, requestedProfile: undefined })
    await waitFor(() => expect(result.current.value).toBe('default'))
    expect(result.current.options.some(option => option.value === 'fund-diagnostician')).toBe(false)
  } finally { dispose() }
})
