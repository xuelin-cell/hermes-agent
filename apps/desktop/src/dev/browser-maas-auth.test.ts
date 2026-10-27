import { afterEach, expect, it, vi } from 'vitest'

import {
  browserAuthKey, clearBrowserAuth, readBrowserAuth, requestEntryMaas, storeBrowserLogin
} from '../../../shared/src/browser-maas-auth.js'

const login = (id: string) => ({ maas_auth: { token: `bearer-${id}`, expiresAt: Date.now() + 60_000, loginId: id } })

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

it('shares the login contract with the renderer and scopes expiry/logout to the deployment and login', () => {
  const alice = login('alice')
  storeBrowserLogin('/hermes', alice)
  expect(readBrowserAuth('/hermes/')).toEqual(alice.maas_auth)
  storeBrowserLogin('/other', login('bob'))
  clearBrowserAuth('/hermes', 'old-login')
  expect(readBrowserAuth('/hermes')?.loginId).toBe('alice')
  localStorage.setItem(browserAuthKey('/hermes'), JSON.stringify({ ...alice.maas_auth, expiresAt: 1 }))
  expect(readBrowserAuth('/hermes')).toBeNull()
  expect(readBrowserAuth('/other')?.loginId).toBe('bob')
  storeBrowserLogin('/other', {})
  expect(readBrowserAuth('/other')).toBeNull()
  localStorage.setItem(browserAuthKey('/hermes'), '{broken')
  expect(readBrowserAuth('/hermes')).toBeNull()
})

it('sends credentials only to fixed entry businesses and rejects late results without clearing a new login', async () => {
  storeBrowserLogin('/hermes', login('alice'))
  const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  await requestEntryMaas('/hermes', 'maas-auth')
  const [url, options] = fetcher.mock.calls[0]
  expect(url).toBe(`${location.origin}/hermes/__entry/maas-auth`)
  expect(options.headers.get('Authorization')).toBe('Bearer bearer-alice')
  expect(options).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
  for (const path of ['https://evil.test', '../__hermes_backend/api', 'drive/../../anything', 'drive?url=evil']) {
    await expect(requestEntryMaas('/hermes', path)).rejects.toThrow()
  }
  expect(fetcher).toHaveBeenCalledTimes(1)
  fetcher.mockResolvedValueOnce(new Response('{}', { status: 500 }))
  await expect(requestEntryMaas('/hermes', 'maas-auth')).rejects.toThrow('500')
  expect(readBrowserAuth('/hermes')?.loginId).toBe('alice')
  let resolve!: (response: Response) => void
  fetcher.mockReturnValueOnce(new Promise<Response>(done => { resolve = done }))
  const pending = requestEntryMaas('/hermes', 'maas-auth')
  storeBrowserLogin('/hermes', login('bob'))
  resolve(new Response('{}', { status: 401 }))
  await expect(pending).rejects.toThrow('账号已切换')
  clearBrowserAuth('/hermes', 'alice')
  expect(readBrowserAuth('/hermes')?.loginId).toBe('bob')
  fetcher.mockResolvedValueOnce(new Response('{}', { status: 401 }))
  await expect(requestEntryMaas('/hermes', 'maas-auth')).rejects.toThrow('登录已失效')
  expect(readBrowserAuth('/hermes')).toBeNull()
})
