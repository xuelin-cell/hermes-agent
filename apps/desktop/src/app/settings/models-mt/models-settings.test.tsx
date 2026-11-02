import type * as HermesApi from '@/hermes'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { ModelsSettings } from './models-settings'

const api = vi.hoisted(() => ({
  getCustomEndpoints: vi.fn().mockResolvedValue({ endpoints: [] }),
  getHermesConfigRecord: vi.fn().mockResolvedValue({}),
  validateCustomEndpoint: vi.fn().mockResolvedValue({ ok: true, message: 'OK' }),
  saveCustomEndpoint: vi.fn(),
  saveHermesConfigRecord: vi.fn(),
  deleteCustomEndpoint: vi.fn()
}))

vi.mock('@/hermes', async importOriginal => ({ ...await importOriginal<typeof HermesApi>(), ...api }))
vi.mock('@/store/model-assignment', () => ({ setMainModelAssignment: vi.fn() }))
afterEach(cleanup)

function show() {
  render(
    <MemoryRouter initialEntries={['/settings?tab=models&addModel=1']}>
      <ModelsSettings />
    </MemoryRouter>
  )
}

it('requires URL, key and model and retains at least one modality', async () => {
  show()
  const save = await screen.findByRole('button', { name: 'Save and apply' })
  expect(save.hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText('Endpoint URL *'), { target: { value: 'https://example.com/v1' } })
  fireEvent.change(screen.getByLabelText('API key *'), { target: { value: 'secret' } })
  fireEvent.change(screen.getByLabelText('Model ID *'), { target: { value: 'test-model' } })
  expect(save.hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Text' }))
  expect(screen.getByRole('button', { name: 'Text' }).getAttribute('aria-pressed')).toBe('true')
})
it('tests the draft through the backend and clears the result when credentials change', async () => {
  show()
  fireEvent.change(await screen.findByLabelText('Endpoint URL *'), { target: { value: 'https://example.com/v1' } })
  fireEvent.change(screen.getByLabelText('API key *'), { target: { value: 'secret' } })
  fireEvent.change(screen.getByLabelText('Model ID *'), { target: { value: 'test-model' } })
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Connected'))
  expect(api.validateCustomEndpoint.mock.calls[0][0]).toMatchObject({
    base_url: 'https://example.com/v1',
    model: 'test-model',
    api_key: 'secret'
  })
  fireEvent.change(screen.getByLabelText('Model ID *'), { target: { value: 'another-model' } })
  expect(screen.queryByRole('status')).toBeNull()
})
