import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopUpdateStatus, DesktopVersionInfo, HermesConnection } from '@/global'
import { TRANSLATIONS } from '@/i18n'
import { en } from '@/i18n/en'
import { LEGAL_LINKS } from '@/lib/legalLinks'
import type * as SessionStore from '@/store/session'
import { $connection } from '@/store/session'
import { requestUpdateCheck } from '@/store/update-check'
import {
  $backendUpdateStatus,
  $desktopVersion,
  $updateChecking,
  $updateStatus,
  checkBackendUpdates,
  refreshDesktopVersion,
  startActiveUpdate,
  type UpdateApplyState
} from '@/store/updates'

import { AboutSettings } from './about-settings'

vi.mock('@/store/session', async (importOriginal): Promise<Record<string, unknown>> => {
  const actual = await importOriginal<typeof SessionStore>()
  const { atom } = await import('nanostores')

  return { ...actual, $connection: atom<HermesConnection | null>(null) }
})

vi.mock('@/store/update-check', () => ({ requestUpdateCheck: vi.fn() }))

vi.mock('@/store/updates', async (): Promise<Record<string, unknown>> => {
  const { atom } = await import('nanostores')

  const idle: UpdateApplyState = {
    applying: false,
    stage: 'idle',
    message: '',
    percent: null,
    error: null,
    command: null,
    log: []
  }

  return {
    $desktopVersion: atom<DesktopVersionInfo | null>(null),
    $backendUpdateApply: atom<UpdateApplyState>(idle),
    $backendUpdateChecking: atom<boolean>(false),
    $backendUpdateStatus: atom<DesktopUpdateStatus | null>(null),
    $updateApply: atom<UpdateApplyState>(idle),
    $updateChecking: atom<boolean>(false),
    $updateStatus: atom<DesktopUpdateStatus | null>(null),
    checkBackendUpdates: vi.fn<() => Promise<DesktopUpdateStatus | null>>().mockResolvedValue(null),
    checkUpdates: vi.fn<() => Promise<DesktopUpdateStatus | null>>().mockResolvedValue(null),
    refreshDesktopVersion: vi.fn<() => Promise<DesktopVersionInfo | null>>().mockResolvedValue(null),
    openUpdateOverlayFor: vi.fn(),
    openUpdatesWindow: vi.fn(),
    startActiveUpdate: vi.fn()
  }
})

function connection(mode: 'local' | 'remote'): HermesConnection {
  return {
    baseUrl: 'http://gateway:9119',
    isFullscreen: false,
    mode,
    nativeOverlayWidth: 0,
    token: 'test-token',
    wsUrl: 'ws://gateway:9119',
    logs: [],
    windowButtonPosition: null
  }
}

describe('AboutSettings', (): void => {
  beforeEach((): void => {
    vi.clearAllMocks()
    Element.prototype.scrollIntoView = vi.fn()
    $updateChecking.set(false)
    $connection.set(connection('local'))
    $desktopVersion.set({
      appVersion: '1.2.3',
      electronVersion: '40',
      nodeVersion: '26',
      platform: 'linux',
      hermesRoot: '/test/hermes',
      installId: 'test-install'
    })
    $updateStatus.set({ supported: true, behind: 0 })
    $backendUpdateStatus.set({ supported: true, behind: 0 })
  })

  afterEach((): void => {
    cleanup()
  })

  it('shows the update status and refreshes each remote gateway independently', (): void => {
    const { container, rerender } = render(<AboutSettings />)

    expect(screen.queryByRole('heading', { name: en.updates.appName })).toBeNull()
    // About dropped its brand header (mark + product name) — the nav entry owns
    // the page identity and the update card names the app. No build-provenance
    // table either (version / commit / build origin / distribution / runtime /
    // install id).
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByText(en.updates.versionDetailsInstallId)).toBeNull()
    expect(screen.queryByText(en.updates.versionDetailsVersion)).toBeNull()
    expect(screen.getByText(en.updates.latestBody)).toBeTruthy()
    expect(screen.queryByText(en.updates.latestBodyBackend)).toBeNull()
    expect(refreshDesktopVersion).toHaveBeenCalledTimes(1)
    expect(checkBackendUpdates).not.toHaveBeenCalled()

    $connection.set(connection('remote'))
    rerender(<AboutSettings />)

    expect(screen.getByText(en.updates.latestBodyBackend)).toBeTruthy()
    expect(checkBackendUpdates).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('link', { name: en.updates.goToWebsite })).toHaveLength(1)

    $connection.set({ ...connection('remote'), baseUrl: 'http://other-gateway:9119' })
    rerender(<AboutSettings />)

    expect(refreshDesktopVersion).toHaveBeenCalledTimes(3)
    expect(checkBackendUpdates).toHaveBeenCalledTimes(2)
  })

  it('shows the fixed package channel with no selector', (): void => {
    $desktopVersion.set({ ...$desktopVersion.get()!, channel: 'canary' })
    render(<AboutSettings />)
    expect(screen.getByText(`${en.updates.latestBody} · ${en.updates.channels.canary}`)).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('merges the agreements into the same page as the update cards', (): void => {
    render(<AboutSettings />)

    // Bare content only: neither section wears a heading or intro copy, and
    // every hosted document stays reachable from the page.
    expect(screen.queryByText(en.settings.subpages.appUpdates)).toBeNull()
    expect(screen.queryByText(en.settings.legal.title)).toBeNull()
    expect(screen.queryByText(en.settings.legal.description)).toBeNull()
    expect(screen.getByRole('button', { name: en.updates.checkForUpdates })).toBeTruthy()

    for (const link of LEGAL_LINKS) {
      expect(screen.getByRole('button', { name: en.settings.legal.items[link.id] })).toBeTruthy()
    }

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  it('ends the page with the agreements strip', (): void => {
    render(<AboutSettings />)

    const updates = globalThis.document.getElementById('setting-field-about.updates')
    const legal = globalThis.document.getElementById('setting-field-about.legal')

    expect(updates).not.toBeNull()
    expect(legal).not.toBeNull()
    // Terms come after the version/update block, and nothing follows them.
    expect(updates!.compareDocumentPosition(legal!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(legal!.tagName).toBe('SECTION')
    expect(legal!.nextElementSibling).toBeNull()
    // The strip is the last block of the pane's footer, so its wrapper is the
    // last thing in the scroll surface.
    expect(legal!.closest('.mt-auto')).not.toBeNull()
  })

  it("names the product on the website row with About's own wordmark", (): void => {
    render(<AboutSettings />)

    // The row pairs About's prefix with its own wordmark; `appName` keeps
    // branding the updates overlay, so the old brand never shows here.
    const row = screen.getByText(en.updates.aboutAppName).closest('p')

    expect(row?.textContent).toBe(`${en.updates.aboutApp}${en.updates.aboutAppName}`)
    expect(row?.textContent).not.toContain(en.updates.appName)
  })

  it('localizes the About wordmark without falling back to the old brand', (): void => {
    expect(TRANSLATIONS.zh.updates.aboutAppName).toBe('元景数字员工')
    expect(TRANSLATIONS['zh-hant'].updates.aboutAppName).toBe('元景數字員工')

    for (const copy of Object.values(TRANSLATIONS)) {
      expect(copy.updates.aboutAppName.trim()).toBeTruthy()
      expect(copy.updates.aboutAppName).not.toContain('UniWork')
    }
  })

  it('lands the legacy legal child route on the merged terms section', (): void => {
    render(<AboutSettings subpage="legal" />)

    const section = globalThis.document.getElementById('setting-field-about.legal')

    expect(section).not.toBeNull()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(section?.classList).toContain('setting-field-highlight')
    // The old route opens the same page, not a terms-only one.
    expect(screen.getByRole('button', { name: en.updates.checkForUpdates })).toBeTruthy()
  })

  it('opens the merged page from the updates child route too', (): void => {
    render(<AboutSettings subpage="updates" />)

    expect(screen.getByRole('button', { name: en.settings.legal.items.userAgreement })).toBeTruthy()
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  it('a commit client refuses updates without hiding an unrelated backend update', (): void => {
    const message: string = "This build doesn't get updates. Ask the developer who gave it to you for a new build."
    $connection.set(connection('remote'))
    $desktopVersion.set({ ...$desktopVersion.get()!, source: 'commit-build' })
    $updateStatus.set({ supported: false, mechanism: 'external', reason: 'commit-build', message })
    $backendUpdateStatus.set({ supported: true, behind: 3 })
    render(<AboutSettings />)
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: en.updates.checkForUpdates })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: en.updates.updateNow }))
    expect(startActiveUpdate).toHaveBeenCalledWith('backend')
  })

  it('routes each card check through its own flow', async (): Promise<void> => {
    $connection.set(connection('remote'))
    render(<AboutSettings />)
    vi.mocked(checkBackendUpdates).mockClear()

    const buttons = screen.getAllByRole('button', { name: en.updates.checkForUpdates })
    fireEvent.click(buttons[0])
    expect(requestUpdateCheck).toHaveBeenCalledTimes(1)
    expect(checkBackendUpdates).not.toHaveBeenCalled()

    fireEvent.click(buttons[1])
    await waitFor((): void => {
      expect(checkBackendUpdates).toHaveBeenCalledWith({ force: true })
    })
    expect(requestUpdateCheck).toHaveBeenCalledTimes(1)
  })

  it('offers a manual update check from the updates section', (): void => {
    render(<AboutSettings />)

    fireEvent.click(screen.getByRole('button', { name: en.updates.checkForUpdates }))

    expect(requestUpdateCheck).toHaveBeenCalledTimes(1)
  })

  // The card's label may already say "update now", but the CLIENT button is
  // still a "check for updates" surface: it enters the one manual-check flow
  // (check → download dialog → ready → launch) instead of applying directly,
  // so About and the sidebar account card cannot drift apart.
  it('routes the client update action through the manual check flow', (): void => {
    $updateStatus.set({ supported: true, behind: 2 })
    render(<AboutSettings />)

    fireEvent.click(screen.getByRole('button', { name: en.updates.updateNow }))

    expect(requestUpdateCheck).toHaveBeenCalledTimes(1)
    expect(startActiveUpdate).not.toHaveBeenCalled()
  })

  it('disables the manual check while one is already running', (): void => {
    $updateChecking.set(true)
    render(<AboutSettings />)

    const button = screen.getByRole('button', { name: en.updates.checkingShort }) as HTMLButtonElement

    expect(button.disabled).toBe(true)
  })
})
