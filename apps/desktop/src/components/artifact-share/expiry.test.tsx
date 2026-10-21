import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'

import { ArtifactExpiryDialog } from './expiry'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  $apiRequestScope.set({ profile: null, connectionId: null })
})

it('自定义有效期只允许 1～7 天，保存失败可原位重试且不发布新链接', async () => {
  const record = {
    key: 'file:report',
    shareId: 'existing-share-id',
    title: 'report.md',
    url: 'https://share.example/report',
    hash: 'hash',
    version: 1,
    updatedAt: 'today'
  }

  const next = { ...record, expiresAt: '2030-01-03T00:00:00Z' }
  const setExpiration = vi.fn().mockRejectedValueOnce(new Error('save failed')).mockResolvedValueOnce(next)
  const onSaved = vi.fn()
  const onClose = vi.fn()
  vi.stubGlobal('hermesDesktop', { artifactShare: { setExpiration, publish: vi.fn() } })
  Element.prototype.scrollIntoView = vi.fn()
  render(<ArtifactExpiryDialog onClose={onClose} onSaved={onSaved} record={record} />)
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Link lifetime' }), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('option', { name: 'Custom days' }))
  const input = screen.getByRole('spinbutton', { name: 'Custom days' })
  fireEvent.change(input, { target: { value: '8' } })
  expect((screen.getByRole('button', { name: 'Save lifetime' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(input, { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save lifetime' }))
  await screen.findByText('save failed')
  expect(onSaved).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save lifetime' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(next))
  expect(setExpiration).toHaveBeenLastCalledWith(record.key, record.shareId, 2)
  expect(window.hermesDesktop.artifactShare.publish).not.toHaveBeenCalled()
})
