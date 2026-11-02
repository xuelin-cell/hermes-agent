import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { StatusbarControls } from '@/app/shell/statusbar-controls'
import { $approvalModes } from '@/store/approval-mode'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { useApprovalModeStatusbarItem } from './approval-mode-menu'

beforeAll(() => {
  stubResizeObserver()
  stubMenuDomApis()
})

afterEach(() => {
  cleanup()
  $approvalModes.set({})
})

function Harness({
  profile = 'default',
  requestGateway
}: {
  profile?: string
  requestGateway: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}) {
  const item = useApprovalModeStatusbarItem(profile, requestGateway)

  return (
    <MemoryRouter>
      <StatusbarControls items={[item]} />
    </MemoryRouter>
  )
}

describe('approval mode statusbar item', () => {
  it('writes the selected mode through the gateway and updates its shared trigger label', async () => {
    const requestGateway = vi.fn(async (_method, params) => ({ value: params?.value ?? 'smart' }))
    render(<Harness profile="work" requestGateway={requestGateway} />)

    fireEvent.pointerDown(screen.getByRole('button', { name: /help me approve/i }), { button: 0 })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^request approval/i }))

    await waitFor(() => {
      expect(requestGateway).toHaveBeenCalledWith('config.set', { key: 'approvals.mode', value: 'manual' })
      expect(screen.getByRole('button', { name: /^request approval/i })).toBeTruthy()
    })
  })
})


it('shows three exclusive modes and explains their behavior without leaving the menu', async () => {
  const requestGateway = vi.fn(async (_method, params) => ({ value: params?.value ?? 'off' }))
  render(<Harness requestGateway={requestGateway} />)
  await screen.findByRole('button', { name: /full access/i })
  fireEvent.pointerDown(screen.getByRole('button', { name: /full access/i }), { button: 0 })
  const modes = await screen.findAllByRole('menuitemradio')
  expect(modes).toHaveLength(3)
  expect(screen.getByRole('menuitemradio', { name: /full access/i }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Learn more' }))
  expect(screen.getByText(/available file and network access still follows/)).toBeTruthy()
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
})
