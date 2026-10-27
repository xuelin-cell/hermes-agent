import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  fetchReleaseNotes,
  notesForVersion,
  parseReleaseNotes,
  readBakedFeedUrl,
  RELEASE_NOTES_MAX_BYTES,
  resolveReleaseNotesUrl
} from './release-notes'

const DOC = JSON.stringify({
  schema: 1,
  notes: {
    '0.0.1': {
      zh: [{ id: 'new', label: '新增', items: ['支持导出全部会话'] }],
      en: [{ id: 'new', label: 'New', items: ['Export every conversation'] }]
    }
  }
})

function response(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return {
    status,
    headers: { get: (name: string): string | null => headers[name.toLowerCase()] ?? null },
    text: async (): Promise<string> => body
  } as unknown as Response
}

describe('authored notes document', () => {
  it('keeps renderable groups and matches the offered version with or without a v prefix', () => {
    const doc = parseReleaseNotes(DOC)

    expect(doc).not.toBeNull()
    expect(notesForVersion(doc, 'v0.0.1')).toMatchObject({ zh: [{ label: '新增', items: ['支持导出全部会话'] }] })
    expect(notesForVersion(doc, '0.0.2')).toBeNull()
  })

  it('drops a document the overlay could not render instead of showing it half-formed', () => {
    const emptyGroups = JSON.stringify({ schema: 1, notes: { '0.0.1': { zh: [{ label: '新增', items: [] }] } } })

    expect(parseReleaseNotes(emptyGroups)).toBeNull()
    expect(parseReleaseNotes(JSON.stringify({ schema: 2, notes: { '0.0.1': { zh: [] } } }))).toBeNull()
    expect(parseReleaseNotes('not a document: [')).toBeNull()
    expect(parseReleaseNotes('')).toBeNull()
  })
})

describe('release notes location', () => {
  const feedDirectory = 'releases/win32/stable'

  it('sits beside the configured feed base, else beside the baked descriptor', () => {
    expect(resolveReleaseNotesUrl({ configuredBase: 'https://mirror.example/hermes', feedDirectory })).toBe(
      'https://mirror.example/hermes/releases/win32/stable/release-notes.json'
    )
    expect(
      resolveReleaseNotesUrl({
        configuredBase: '',
        feedDirectory,
        descriptorUrl: 'https://obs.example/installer/unihermes/releases/win32/stable/'
      })
    ).toBe('https://obs.example/installer/unihermes/releases/win32/stable/release-notes.json')
  })

  it('has no location without a feed, and refuses a descriptor that is not a trusted origin', () => {
    expect(resolveReleaseNotesUrl({ configuredBase: '', feedDirectory })).toBeNull()
    expect(
      resolveReleaseNotesUrl({ configuredBase: '', feedDirectory, descriptorUrl: 'file:///etc/app-update.yml' })
    ).toBeNull()
  })

  it('reads the url electron-updater itself resolves', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'))
    const descriptor = path.join(dir, 'app-update.yml')

    fs.writeFileSync(descriptor, 'provider: generic\nurl: https://obs.example/releases/win32/stable/\nchannel: stable\n')

    try {
      expect(readBakedFeedUrl(descriptor)).toBe('https://obs.example/releases/win32/stable/')
      expect(readBakedFeedUrl(path.join(dir, 'absent.yml'))).toBeNull()
      expect(readBakedFeedUrl(null)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('fetching authored notes', () => {
  const url = 'https://obs.example/releases/win32/stable/release-notes.json'

  it('returns the copy for the offered version and asks for no redirects', async () => {
    const fetchImpl = vi.fn(async () => response(DOC))

    const notes = await fetchReleaseNotes(url, '0.0.1', () => {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(notes).toMatchObject({ en: [{ items: ['Export every conversation'] }] })
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error' }))
  })

  it('resolves null for a missing, oversized or unreachable object', async () => {
    const log = vi.fn()

    const attempts = [
      vi.fn(async () => response('', 404)),
      vi.fn(async () => response('x'.repeat(RELEASE_NOTES_MAX_BYTES + 1))),
      vi.fn(async () => {
        throw new Error('offline')
      })
    ]

    for (const fetchImpl of attempts) {
      await expect(
        fetchReleaseNotes(url, '0.0.1', log, { fetchImpl: fetchImpl as unknown as typeof fetch })
      ).resolves.toBeNull()
    }

    expect(log).toHaveBeenCalledTimes(attempts.length)
  })
})
