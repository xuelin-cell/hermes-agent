import { waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { skillMarketInstallPending } from '@/lib/browser-shell'
import { notify } from '@/store/notifications'

import { storeBrowserLogin } from '../../../shared/src/browser-maas-auth.js'

import { browserSkills, isCloudSkillMutation } from './browser-skills'

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn(), dismissNotification: vi.fn() }))
vi.mock('@/lib/query-client', () => ({ queryClient: { invalidateQueries: vi.fn().mockResolvedValue(undefined) } }))
vi.mock('@/lib/slash-completion-cache', () => ({ invalidateSlashCompletions: vi.fn() }))
const input = { method: 'POST' as const, path: '/api/skills/market/install', body: { id: 'writing', download_url: 'https://maas.ai-yuanjing.com/package.zip' } }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const login = (id: string) => storeBrowserLogin('/hermes', { maas_auth: { token: 'private-' + id, loginId: id, expiresAt: Date.now() + 60_000 } })
afterEach(() => { localStorage.clear(); delete window.document.documentElement.dataset.hermesBrowser; vi.unstubAllGlobals(); vi.clearAllMocks() })

it('云端安装只提交一次并等待保存确认，成功后保持现有 REST 返回值及桌面能力约束', async () => {
  login('alice')
  window.document.documentElement.dataset.hermesBrowser = 'production'
  const bridge = browserSkills('/hermes')
  vi.stubGlobal('hermesDesktop', { cloudSkillOperations: bridge })
  expect(skillMarketInstallPending('zh')).toBeNull()
  expect(isCloudSkillMutation('GET', '/api/skills')).toBe(false)
  expect(isCloudSkillMutation('PUT', '/api/skills/toggle')).toBe(true)
  const phases = ['changing', 'saving', 'saved']

  const request = vi.fn(async (url: string, options: RequestInit) => {
    expect(options.credentials).toBe('same-origin')
    expect(new Headers(options.headers).has('Authorization')).toBe(false)
    const { id } = JSON.parse(options.body as string)

    return json({ id, phase: url.endsWith('/start') ? 'changing' : phases.shift(), result: { ok: true, name: 'safe-writing', install_path: '/skills/safe-writing' } })
  })

  vi.stubGlobal('fetch', request)
  const [a, b] = await Promise.all([bridge.mutate(input), bridge.mutate(input)])
  expect(a).toEqual(b)
  expect(a).toMatchObject({ ok: true, name: 'safe-writing' })
  expect(request.mock.calls.filter(([url]) => url.endsWith('/start'))).toHaveLength(1)
  expect(request.mock.calls.filter(([url]) => url.endsWith('/status'))).toHaveLength(3)
  request.mockImplementation(async (_url, options) => {
    const { id } = JSON.parse(options.body as string)
    return json({ id, phase: 'failed', error: 'Skill rejected by scanner' })
  })
  await expect(bridge.mutate({ ...input, body: { ...input.body, id: 'blocked' } })).rejects.toThrow('Skill rejected by scanner')
  await expect(bridge.mutate({ ...input, profile: 'other' })).rejects.toThrow()
  expect(JSON.stringify(request.mock.calls)).not.toContain('private-alice')
})

it('保存失败提供仅重试保存的操作，不重复安装；账号切换后拒绝迟到结果', async () => {
  login('alice')
  const bridge = browserSkills('/hermes')
  let saved = false

  const request = vi.fn(async (url: string, options: RequestInit) => {
    const { id } = JSON.parse(options.body as string)

    return json({ id, phase: url.endsWith('/start') ? 'changing' : saved ? 'saved' : 'save_failed',
      error: 'Changes not saved', result: saved ? { ok: true } : null })
  })

  vi.stubGlobal('fetch', request)
  await expect(bridge.mutate(input)).rejects.toThrow('Changes not saved')
  const warning = vi.mocked(notify).mock.calls.map(([value]) => value).find(value => value.action)
  expect(warning?.kind).toBe('warning')
  saved = true
  warning!.action!.onClick()
  await waitFor(() => expect(request.mock.calls.filter(([url]) => url.endsWith('/retry-save'))).toHaveLength(1))
  await waitFor(() => expect(vi.mocked(notify).mock.calls.some(([value]) => value.kind === 'success')).toBe(true))
  expect(request.mock.calls.filter(([url]) => url.endsWith('/start'))).toHaveLength(1)
  const other = browserSkills('/hermes')
  request.mockImplementationOnce(async () => { login('bob');

 return json({ id: 'old', phase: 'saved', result: { ok: true } }) })
  await expect(other.mutate(input)).rejects.toThrow()
})

it('returns an uninstalled scan review and uses a fresh operation for hash approval', async () => {
  login('alice')
  const bridge = browserSkills('/hermes')
  const review = { ok: false, requires_confirmation: true, package_hash: 'reviewed', report: 'DANGEROUS' }
  const request = vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string)
    return json({ id: body.id, phase: 'confirmation', result: review })
  })
  vi.stubGlobal('fetch', request)
  expect(await bridge.mutate(input)).toEqual(review)
  await bridge.mutate({ ...input, body: { ...input.body, approved_hash: 'reviewed' } })
  const starts = request.mock.calls.filter(([url]) => url.endsWith('/start')).map(([, options]) => JSON.parse(options.body as string))
  expect(starts).toHaveLength(2)
  expect(starts[0].id).not.toBe(starts[1].id)
  expect(starts[1].body.approved_hash).toBe('reviewed')
  expect(vi.mocked(notify).mock.calls.some(([notice]) => notice.kind === 'success')).toBe(false)
})
