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

    // The footer strip carries no heading or intro of its own.
    expect(screen.queryByText(en.settings.legal.title)).toBeNull()
    expect(screen.queryByText(en.settings.legal.description)).toBeNull()

    const labels: string[] = LEGAL_LINKS.map(link => en.settings.legal.items[link.id])

    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(labels)

    for (const link of LEGAL_LINKS) {
      fireEvent.click(screen.getByRole('button', { name: en.settings.legal.items[link.id] }))
      expect(openExternalLink).toHaveBeenCalledWith(link.url)
    }
  })

  it('renders the documents as one inline strip inside the About anchor', (): void => {
    render(<LegalSettings />)

    const section = globalThis.document.getElementById('setting-field-about.legal')

    // The anchor lives on the outermost section so a deep link scroll lands with
    // the heading in view; the strip itself is decoration + plain text links.
    expect(section?.tagName).toBe('SECTION')
    expect(screen.getAllByRole('button')).toHaveLength(LEGAL_LINKS.length)
    expect(section?.textContent?.match(/\|/g)).toHaveLength(LEGAL_LINKS.length - 1)
  })
})
