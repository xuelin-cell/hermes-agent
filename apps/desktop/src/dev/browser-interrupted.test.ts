import { afterEach, expect, it, vi } from 'vitest'
import { storeBrowserLogin } from '../../../shared/src/browser-maas-auth.js'
import { browserInterrupted } from './browser-interrupted'

const login = (id: string) => storeBrowserLogin('/hermes', { maas_auth: { loginId: id, token: id, expiresAt: Date.now()+60000 } })
afterEach(() => { localStorage.clear() })

it('dismisses under the owning expert and discards recovery results from a previous login', async () => {
  login('alice')
  const turn = { sessionId: 'session', prompt: 'task', detectedAt: Date.now(), profile: 'expert-a' }
  const api = vi.fn().mockResolvedValue({ turns: [turn] })
  const bridge = browserInterrupted('/hermes', api)
  expect(await bridge.interruptedTurns.list()).toEqual([turn])
  await bridge.interruptedTurns.dismiss('session')
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({ body: { profile: 'expert-a', sessionId: 'session' } }))
  let finish: (value: unknown) => void = () => undefined
  api.mockImplementationOnce(() => new Promise(resolve => { finish=resolve }))
  const pending = bridge.interruptedTurns.list()
  login('bob')
  finish({ turns: [turn] })
  expect(await pending).toEqual([])
  const count = api.mock.calls.length
  await bridge.interruptedTurns.dismiss('session')
  expect(api).toHaveBeenCalledTimes(count)
})
