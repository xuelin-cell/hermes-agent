import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import type * as ExternalLinkModule from '@/lib/external-link'
import { LEGAL_LINKS } from '@/lib/legalLinks'

import { LegalSettings } from './legal-settings'

const openExternalLink = vi.fn()

vi.mock('@/lib/external-link', async (importOriginal): Promise<Record<string, unknown>> => {
  const actual = await importOriginal<typeof ExternalLinkModule>()

  return { ...actual, openExternalLink: (href: string) => openExternalLink(href) }
})

describe('LegalSettings', (): void => {
  afterEach((): void => {
    cleanup()
    vi.clearAllMocks()
  })

  it('lists every hosted document in catalog order and opens it in the system browser', (): void => {
    render(<LegalSettings />)

    expect(screen.getByText(en.settings.legal.title)).toBeTruthy()
    expect(screen.getByText(en.settings.legal.description)).toBeTruthy()

    const labels: string[] = LEGAL_LINKS.map(link => en.settings.legal.items[link.id])

    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(labels)

    for (const link of LEGAL_LINKS) {
      fireEvent.click(screen.getByRole('button', { name: en.settings.legal.items[link.id] }))
      expect(openExternalLink).toHaveBeenCalledWith(link.url)
    }
  })
})
