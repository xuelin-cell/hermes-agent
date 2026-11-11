import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { $settingsScopeOverride } from '@/store/settings-scope'

const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }))
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof import('@/hermes')>()),
  getHermesConfigRecord: (...args: unknown[]) => api.read(...args),
  saveHermesConfig: (...args: unknown[]) => api.save(...args)
}))
import { PrivacySettings } from './privacy-settings'

it('keeps privacy writes isolated when switching A to B and back to A', async () => {
  const homes = new Map(
    ['scope-a', 'scope-b'].map(profile => [
      profile,
      { marker: profile, plugins: { entries: { 'uniwork-telemetry': { settings: { enabled: true } } } } }
    ])
  )
  api.read.mockImplementation(async profile => structuredClone(homes.get(profile)))
  api.save.mockImplementation(async (config, profile) => {
    homes.set(profile, structuredClone(config))
    return { ok: true }
  })
  const previous = $settingsScopeOverride.get()
  $settingsScopeOverride.set('scope-a')
  const view = render(<PrivacySettings />)
  try {
    const switches = await screen.findAllByRole('switch')
    await waitFor(() => expect((switches[1] as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(switches[1])
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1))
    await waitFor(() => expect((switches[1] as HTMLButtonElement).disabled).toBe(false))
    act(() => $settingsScopeOverride.set('scope-b'))
    await waitFor(() => expect(api.read).toHaveBeenLastCalledWith('scope-b'))
    await waitFor(() => expect(switches[1].getAttribute('aria-checked')).toBe('true'))
    act(() => $settingsScopeOverride.set('scope-a'))
    await waitFor(() => expect(switches[1].getAttribute('aria-checked')).toBe('false'))
    expect(homes.get('scope-b')?.plugins.entries['uniwork-telemetry'].settings.enabled).toBe(true)
    expect(homes.get('scope-a')?.marker).toBe('scope-a')
  } finally {
    view.unmount()
    $settingsScopeOverride.set(previous)
  }
})
