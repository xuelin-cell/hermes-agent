import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@hermes/plugin-sdk', async () => {
  const { atom } = await import('nanostores')
  const { useStore } = await import('@nanostores/react')
  return { atom, useValue: useStore }
})
vi.mock('./api', () => ({ fetchExpertAvatar: vi.fn(), fetchExperts: vi.fn() }))

import { fetchExpertAvatar, fetchExperts } from './api'
import { ExpertFace } from './expert-face'
import { $expertAvatars, loadExperts } from './experts-store'
import type { ExpertCard } from './types'

afterEach(cleanup)

it('shares portrait requests and recovers a missing portrait after an explicit catalog refresh', async () => {
  const expert = { name: 'portrait-retry', display_name: '抖音运营专家' } as ExpertCard
  $expertAvatars.set({})
  vi.mocked(fetchExpertAvatar).mockRejectedValueOnce(new Error('instance starting'))
    .mockResolvedValueOnce({ data_url: 'data:image/png;base64,Y2F0' })
  vi.mocked(fetchExperts).mockResolvedValue({ experts: [], recent: [] })
  const view = render(<><ExpertFace expert={expert} /><ExpertFace expert={expert} size={36} /></>)
  await waitFor(() => expect(fetchExpertAvatar).toHaveBeenCalledTimes(1))
  await act(async () => { await Promise.resolve() })
  expect(view.container.querySelectorAll('img')).toHaveLength(0)
  await act(async () => { await loadExperts() })
  await waitFor(() => expect(view.container.querySelectorAll('img')).toHaveLength(2))
  expect(fetchExpertAvatar).toHaveBeenCalledTimes(2)
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,Y2F0')
  await act(async () => { await loadExperts() })
  expect(fetchExpertAvatar).toHaveBeenCalledTimes(2)
})
