import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'

import type { LocalConnectorResult } from '../../../../electron/open-connector/contract'

import { WecomQrForm } from './wecom-qr-form'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderForm(
  request: (
    operation: 'qr.start' | 'qr.poll' | 'qr.cancel',
    sessionId?: string
  ) => Promise<LocalConnectorResult | null>,
  onConnected = vi.fn()
) {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <WecomQrForm onConnected={onConnected} request={request} />
    </I18nProvider>
  )
  return { ...view, onConnected }
}

it('starts, polls, confirms, and cancels the owned QR session on cleanup', async () => {
  const request = vi.fn(async operation => {
    if (operation === 'qr.start') return { connectors: [], sessionId: 'session-1', qrImage: 'data:image/svg+xml,qr' }
    if (operation === 'qr.poll') return { connectors: [], qrState: 'confirmed' as const }
    return { connectors: [] }
  })
  const { onConnected, unmount } = renderForm(request)

  await act(async () => void (await Promise.resolve()))
  expect(request).toHaveBeenCalledWith('qr.start')
  expect(screen.getByRole('img')).toBeTruthy()

  await act(async () => void (await vi.advanceTimersByTimeAsync(3000)))
  expect(request).toHaveBeenCalledWith('qr.poll', 'session-1')
  expect(onConnected).toHaveBeenCalledOnce()

  unmount()
  await act(async () => void (await Promise.resolve()))
  expect(request).toHaveBeenCalledWith('qr.cancel', 'session-1')
})

it('shows expiry and refreshes with a new session while cancelling the old one', async () => {
  let starts = 0
  const request = vi.fn(async operation => {
    if (operation === 'qr.start') {
      starts += 1
      return { connectors: [], sessionId: `session-${starts}`, qrImage: `data:image/svg+xml,qr-${starts}` }
    }
    if (operation === 'qr.poll') return { connectors: [], qrState: 'expired' as const }
    return { connectors: [] }
  })
  renderForm(request)

  await act(async () => void (await Promise.resolve()))
  await act(async () => void (await vi.advanceTimersByTimeAsync(3000)))
  expect(screen.getByRole('alert').textContent).toContain('二维码已过期')

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '重新生成二维码' }))
    await Promise.resolve()
  })
  expect(request).toHaveBeenCalledWith('qr.cancel', 'session-1')
  expect(request).toHaveBeenCalledWith('qr.start')
})
