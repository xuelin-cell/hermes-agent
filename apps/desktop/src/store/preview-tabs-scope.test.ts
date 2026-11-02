import './session-states'

// Regression: the right rail's tabs were persisted under ONE global key
// (`hermes.desktop.previewTabs.v2` holding a bare array), so a preview opened in
// one agent's chat appeared in every other agent's chat — Tess's model showed up
// in VEXA's rail and vice versa.
//
// Contract under test: the rail follows THE CHAT ON SCREEN. That is deliberately
// NOT the window's gateway socket — a focused tab does not swap the socket, and
// every bot chat is served by one pooled backend, so a socket-keyed rail shows
// one agent's previews in every agent's chat. That is the same trap
// `bot-row.tsx` documents for the roster highlight, and it is why the first cut
// of this fix did not work. `session-states.ts` resolves the focused session's
// owner and pushes it in via `setPreviewScope`.
import { beforeEach, describe, expect, it } from 'vitest'

import { $rightRailActiveTabId } from '@/store/layout'
import {
  $previewTabs,
  migratePreviewTabsForProfile,
  openPreview,
  type PreviewTarget,
  setPreviewScope
} from '@/store/preview'
import { normalizeProfileKey } from '@/store/profile'

import { $activeSessionId } from './session'

const TABS_KEY = 'hermes.desktop.previewTabs.v2'

function fileTarget(path: string): PreviewTarget {
  return {
    kind: 'file',
    label: path.split('/').pop() ?? path,
    path,
    source: path,
    url: `file://${path}`
  }
}

const paths = () => $previewTabs.get().map(tab => tab.target.path)

function storedBuckets(): Record<string, { target: { path?: string } }[]> {
  const raw = window.localStorage.getItem(TABS_KEY)

  return raw ? (JSON.parse(raw) as Record<string, { target: { path?: string } }[]>) : {}
}

describe('right rail follows the chat on screen', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setPreviewScope('default')
    $previewTabs.set([])
  })

  it('does not show one agent the tabs another agent opened', () => {
    setPreviewScope('tess')
    openPreview(fileTarget('/work/tess-model.html'))

    expect(paths()).toEqual(['/work/tess-model.html'])

    // Reading another agent's chat re-homes the rail.
    setPreviewScope('default')

    expect($previewTabs.get()).toEqual([])

    // ...and comes back, unchanged, on the way in.
    setPreviewScope('tess')

    expect(paths()).toEqual(['/work/tess-model.html'])
    expect(Object.keys(storedBuckets())).toEqual([normalizeProfileKey('tess')])
  })

  it('moves the rail with a rename instead of stranding it under the old name', () => {
    setPreviewScope('tess')
    openPreview(fileTarget('/work/tess-model.html'))

    migratePreviewTabsForProfile('tess', 'tess-renamed')

    const buckets = storedBuckets()

    expect(buckets[normalizeProfileKey('tess')]).toBeUndefined()
    expect(buckets[normalizeProfileKey('tess-renamed')]?.map(tab => tab.target.path)).toEqual(['/work/tess-model.html'])
  })
})

it('isolates conversation tabs and restores the selected file on A → B → A', () => {
  setPreviewScope('conversation-test', 'A', 'local')
  openPreview(fileTarget('/work/a.md'))
  const first = $rightRailActiveTabId.get()
  openPreview(fileTarget('/work/a-second.md'))
  $rightRailActiveTabId.set(first)
  setPreviewScope('conversation-test', 'B', 'local')
  expect(paths()).toEqual([])
  expect($rightRailActiveTabId.get()).toBeNull()
  openPreview(fileTarget('/work/b.md'))
  setPreviewScope('conversation-test', 'A', 'local')
  expect(paths()).toEqual(['/work/a.md', '/work/a-second.md'])
  expect($rightRailActiveTabId.get()).toBe(first)
  setPreviewScope('conversation-test', 'new-chat', 'local')
  expect(paths()).toEqual([])
  setPreviewScope('conversation-test', 'B', 'local')
  expect(paths()).toEqual(['/work/b.md'])
  $activeSessionId.set('integration-A')
  openPreview(fileTarget('/integration/a.md'))
  $activeSessionId.set('integration-B')
  expect(paths()).toEqual([])
  $activeSessionId.set('integration-A')
  expect(paths()).toEqual(['/integration/a.md'])
  $activeSessionId.set(null)
  expect(paths()).toEqual([])
})

it('keeps conversation previews across profile rename and separates connections', () => {
  setPreviewScope('before-rename', 'same-id', 'one')
  openPreview(fileTarget('/one.md'))
  setPreviewScope('before-rename', 'same-id', 'two')
  expect(paths()).toEqual([])
  openPreview(fileTarget('/two.md'))
  migratePreviewTabsForProfile('before-rename', 'after-rename')
  expect(paths()).toEqual(['/two.md'])
  setPreviewScope('after-rename', 'same-id', 'one')
  expect(paths()).toEqual(['/one.md'])
})
