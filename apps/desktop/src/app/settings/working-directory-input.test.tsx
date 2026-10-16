import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $activeConnectionId } from '@/store/connections'
import { requestGatewayForAgent } from '@/store/gateway'
import { $settingsScopeProfile } from '@/store/settings-scope'

import { ConfigField } from './config-field'

vi.mock('@/store/connections', () => ({ $activeConnectionId: atom('local') }))
vi.mock('@/store/settings-scope', () => ({ $settingsScopeProfile: atom('default') }))
vi.mock('@/store/gateway', () => ({ requestGatewayForAgent: vi.fn() }))

beforeEach(() => {
  ;($activeConnectionId as unknown as { set: (value: string) => void }).set('local')
  ;($settingsScopeProfile as unknown as { set: (value: string) => void }).set('default')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** 保留真实字段和受控编辑回传，只替换后端目录查询。 */
function DirectorySetting({ initial = '.', onChange }: { initial?: string; onChange: (value: string) => void }) {
  const [value, setValue] = useState(initial)

  return (
    <ConfigField
      onChange={next => {
        setValue(String(next))
        onChange(String(next))
      }}
      schema={{ type: 'string' }}
      schemaKey="terminal.cwd"
      value={value}
    />
  )
}

/** 每次使用独立查询缓存，避免前一次账号或 Profile 的数据混入。 */
function renderDirectory(initial: string, onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={client}>
      <DirectorySetting initial={initial} onChange={onChange} />
    </QueryClientProvider>
  )

  return onChange
}

it('shows the resolved default without writing it, while preserving explicit edits and clearing', async () => {
  const workspace = 'C:\\Users\\test\\accounts\\account-a\\workspace'
  vi.mocked(requestGatewayForAgent).mockResolvedValue({ cwd: workspace })
  const onChange = renderDirectory('.')

  const input = await screen.findByDisplayValue(workspace, {}, { timeout: 2_000 })
  expect(requestGatewayForAgent).toHaveBeenCalledWith('local', 'default', 'config.get', { key: 'project', cwd: '.' })
  expect(onChange).not.toHaveBeenCalled()

  fireEvent.change(input, { target: { value: 'D:\\my-project' } })
  fireEvent.blur(input)
  expect(screen.getByDisplayValue('D:\\my-project')).toBe(input)
  expect(onChange).toHaveBeenLastCalledWith('D:\\my-project')

  fireEvent.change(input, { target: { value: '' } })
  expect(screen.getByDisplayValue('')).toBe(input)
  expect(onChange).toHaveBeenLastCalledWith('')
  fireEvent.blur(input)
  expect(await screen.findByDisplayValue(workspace)).toBe(input)

  cleanup()
  vi.mocked(requestGatewayForAgent).mockClear()
  const customChange = renderDirectory('E:\\personal-project')
  expect(screen.getByDisplayValue('E:\\personal-project')).toBeTruthy()
  expect(requestGatewayForAgent).not.toHaveBeenCalled()
  expect(customChange).not.toHaveBeenCalled()
})

it('reads the selected connection and profile without showing a late response from the previous scope', async () => {
  let resolvePrevious!: (value: { cwd: string }) => void
  vi.mocked(requestGatewayForAgent).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolvePrevious = resolve
      })
  )
  vi.mocked(requestGatewayForAgent).mockResolvedValue({ cwd: 'D:\\account-b\\workspace' })
  const onChange = renderDirectory('.')

  await waitFor(() => expect(requestGatewayForAgent).toHaveBeenCalledTimes(1))
  act(() => {
    ;($activeConnectionId as unknown as { set: (value: string) => void }).set('other-connection')
    ;($settingsScopeProfile as unknown as { set: (value: string) => void }).set('bot-b')
  })

  await screen.findByDisplayValue('D:\\account-b\\workspace', {}, { timeout: 2_000 })
  expect(requestGatewayForAgent).toHaveBeenLastCalledWith('other-connection', 'bot-b', 'config.get', {
    key: 'project',
    cwd: '.'
  })

  await act(async () => {
    resolvePrevious({ cwd: 'C:\\account-a\\workspace' })
  })
  expect(screen.getByDisplayValue('D:\\account-b\\workspace')).toBeTruthy()
  expect(screen.queryByDisplayValue('C:\\account-a\\workspace')).toBeNull()
  expect(onChange).not.toHaveBeenCalled()
})
