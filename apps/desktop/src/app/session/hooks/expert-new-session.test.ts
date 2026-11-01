import { atom } from 'nanostores'
import { afterEach, expect, it, vi } from 'vitest'

import type { ExpertCard } from '@/plugins/uniwork-kits/types'
import { composerHost } from '@/sdk/composer'
import { clearSessionDraft, stashSessionDraft, takeSessionDraft } from '@/store/composer'

const state = {
  focusedSessionProfile: atom('writer'),
  focusedSessionId: atom<string | null>(null),
  focusedStoredSessionId: atom<string | null>(null)
}

const composer = { ...composerHost, getDraft: vi.fn(), setDraft: vi.fn(async () => true) }
vi.mock('@hermes/plugin-sdk', () => ({
  atom,
  BACKEND_BOOT_WAIT_TIMEOUT_MS: 180_000,
  host: { state, composer, newChat: vi.fn() }
}))
vi.mock('@/store/gateway', () => ({ openPooledProfileCount: () => 0 }))
vi.mock('@/plugins/uniwork-kits/api', () => ({ recordSummon: async () => ({ recent: [] }) }))
vi.mock('@/plugins/uniwork-kits/connector-login', () => ({
  offerConnectorLogin: vi.fn(),
  dismissConnectorLogin: vi.fn(),
  connectorLoginBlocksSend: () => false
}))

const { resetExpertDraft, summonExpert } = await import('@/plugins/uniwork-kits/summon')

afterEach(() => {
  resetExpertDraft()
  clearSessionDraft('saved-expert-chat')
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('clears only the fresh expert draft and rejects opening prompts still waiting on a draft read', async () => {
  vi.useFakeTimers()
  let finishRead!: (text: string) => void
  composer.getDraft.mockImplementation(() => new Promise<string>(resolve => (finishRead = resolve)))

  const expert: ExpertCard = {
    name: 'writer',
    profile: 'writer',
    display_name: '写作专家',
    profession: '',
    description: '',
    init_prompt: '专家开场白',
    quick_prompts: [],
    try_asking: '',
    tags: []
  }

  stashSessionDraft(null, expert.init_prompt, [])
  stashSessionDraft('saved-expert-chat', '保留原专家会话中的草稿', [])
  summonExpert(expert)
  await vi.advanceTimersByTimeAsync(150)
  expect(composer.getDraft).toHaveBeenCalledOnce()

  resetExpertDraft()
  // The old backend can still be focused while the default backend starts.
  finishRead('')
  await vi.advanceTimersByTimeAsync(1000)

  expect(composer.setDraft).not.toHaveBeenCalled()
  expect(takeSessionDraft(null).text).toBe('')
  expect(takeSessionDraft('saved-expert-chat').text).toBe('保留原专家会话中的草稿')
})
