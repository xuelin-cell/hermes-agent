// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { TRANSLATIONS } from '@/i18n'
import { COMPLETION_SOUND_VARIANTS } from '@/lib/completion-sound'
import { DEFAULT_COMPLETION_SOUND_VARIANT_ID } from '@/store/completion-sound'
import { $developerMode } from '@/store/developer-mode'

import { NotificationsSettings } from './notifications-settings'

const nativeNotificationIntro = TRANSLATIONS.en.settings.notifications.intro

afterEach(() => {
  cleanup()
  $developerMode.set(false)
})

describe('notifications developer-only intro', () => {
  it('仅在开发者模式下显示原生桌面通知说明', () => {
    $developerMode.set(false)

    const view = render(
      <MemoryRouter>
        <NotificationsSettings />
      </MemoryRouter>
    )

    expect(screen.queryByText(nativeNotificationIntro)).toBeNull()

    view.unmount()
    $developerMode.set(true)

    render(
      <MemoryRouter>
        <NotificationsSettings />
      </MemoryRouter>
    )

    expect(screen.getByText(nativeNotificationIntro)).toBeTruthy()
  })

  it('普通模式不显示声音选择器，开发者模式默认选择 Two-note comfort', () => {
    $developerMode.set(false)

    const view = render(
      <MemoryRouter>
        <NotificationsSettings />
      </MemoryRouter>
    )

    expect(screen.queryByRole('combobox')).toBeNull()

    view.unmount()
    $developerMode.set(true)

    render(
      <MemoryRouter>
        <NotificationsSettings />
      </MemoryRouter>
    )

    expect(screen.getByRole('combobox').textContent).toContain('Two-note comfort')
    expect(COMPLETION_SOUND_VARIANTS.find(({ id }) => id === DEFAULT_COMPLETION_SOUND_VARIANT_ID)?.name).toBe(
      'Two-note comfort'
    )
  })

  it('即使直接请求声音子页，普通模式也不显示声音选择器', () => {
    $developerMode.set(false)

    render(
      <MemoryRouter>
        <NotificationsSettings subpage="sounds" />
      </MemoryRouter>
    )

    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
