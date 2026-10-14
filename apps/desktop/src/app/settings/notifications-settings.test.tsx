// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { TRANSLATIONS } from '@/i18n'
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
})
