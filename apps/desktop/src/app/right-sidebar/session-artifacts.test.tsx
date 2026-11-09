import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesReadDirResult, HermesPreviewTarget } from '@/global'
import { I18nProvider } from '@/i18n'
import {
  $connection,
  $selectedStoredSessionId,
  $workspaceCwdOwner,
  setCurrentCwd
} from '@/store/session'

// Mock getAllSessionMessages on the @/hermes barrel to avoid the full api
// client chain during test module resolution. Use vi.hoisted so the mock
// function is available to the hoisted vi.mock factory.
const { getAllSessionMessages } = vi.hoisted(() => ({ getAllSessionMessages: vi.fn() }))

vi.mock('@/hermes', () => ({ getAllSessionMessages }))

import { SessionArtifactsPane } from './session-artifacts'

// Bridge mocks: the pane reads dir + normalizes preview targets through the
// desktop bridge. We stub the minimum surface the pane touches.
const readDir = vi.fn<(path: string) => Promise<HermesReadDirResult>>()
const normalizePreviewTarget = vi.fn<(target: string, baseDir?: string) => Promise<HermesPreviewTarget | null>>()

function installBridge() {
  ;(window as unknown as { hermesDesktop: { readDir: typeof readDir; normalizePreviewTarget: typeof normalizePreviewTarget } }).hermesDesktop = {
    readDir,
    normalizePreviewTarget
  }
}

function renderPane() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <SessionArtifactsPane />
    </I18nProvider>
  )
}

describe('SessionArtifactsPane', () => {
  beforeEach(() => {
    $connection.set(null)
    $selectedStoredSessionId.set(null)
    $workspaceCwdOwner.set(null)
    readDir.mockReset()
    readDir.mockResolvedValue({ entries: [{ isDirectory: false, name: 'README.md', path: '/repo/README.md' }] })
    normalizePreviewTarget.mockReset()
    normalizePreviewTarget.mockResolvedValue(null)
    getAllSessionMessages.mockReset()
    getAllSessionMessages.mockResolvedValue({ messages: [] })
    installBridge()
  })

  afterEach(() => {
    cleanup()
    $connection.set(null)
    $selectedStoredSessionId.set(null)
    $workspaceCwdOwner.set(null)
    setCurrentCwd('')
    delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  })

  it('renders the pane with refresh button', () => {
    renderPane()

    expect(screen.getByRole('button', { name: 'Refresh tree' })).toBeTruthy()
  })
})