import { expect, it, vi } from 'vitest'

import { AGENT_MAIL_CLOUD_STATE_KEY, AgentMailCloudStateClient } from './cloud-state'
import type { LoginIdentity } from '../login/session'

const account = (uid: string, token: string): LoginIdentity => ({
  uid,
  token,
  phone: '13800138000',
  maskedPhone: '138****8000',
  expiresAt: Date.now() + 60_000
})

it('reads an absent or strictly valid state for the expected login identity', async () => {
  let identity = account('a', 'token-a')
  const state = {
    enabled: true,
    email: '13800138000@wo.cn',
    phone: '13800138000',
    updatedAt: '2026-10-20T00:00:00.000Z'
  }
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(
      Response.json({
        userid: 'server-owned',
        key: AGENT_MAIL_CLOUD_STATE_KEY,
        value: JSON.stringify(state),
        valueType: null,
        version: 'v1',
        updateTime: '2026-10-20T00:00:00'
      })
    )
  const client = new AgentMailCloudStateClient(() => identity, request)

  await expect(client.read(identity)).resolves.toEqual({ status: 'available', exists: false, state: null })
  await expect(client.read(identity)).resolves.toEqual({ status: 'available', exists: true, state })
  expect(request.mock.calls[0]?.[0]).toBe(
    `https://mass.ai-yuanjing.com/app/gateway/users/config?key=${AGENT_MAIL_CLOUD_STATE_KEY}`
  )
  expect(request.mock.calls[0]?.[1]?.headers).toEqual({
    Accept: 'application/json',
    Authorization: 'Bearer token-a'
  })
})

it('writes JSON state without forwarding a userid and rechecks identity after success', async () => {
  let identity = account('a', 'token-a')
  let release!: () => void
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })
  const request = vi.fn<typeof fetch>(async () => {
    await waiting
    return Response.json({ key: AGENT_MAIL_CLOUD_STATE_KEY, value: '{}', valueType: 'json' })
  })
  const client = new AgentMailCloudStateClient(() => identity, request)
  const expected = identity
  const state = { enabled: false, phone: '13800138000', updatedAt: '2026-10-20T00:00:00.000Z' }

  const pending = client.write(expected, state)
  identity = account('b', 'token-b')
  release()

  await expect(pending).resolves.toEqual({ status: 'failed', reason: 'auth' })
  expect(request.mock.calls[0]?.[0]).toBe('https://mass.ai-yuanjing.com/app/gateway/users/config')
  expect(request.mock.calls[0]?.[1]?.method).toBe('PUT')
  expect(request.mock.calls[0]?.[1]?.headers).toEqual({
    Accept: 'application/json',
    Authorization: 'Bearer token-a',
    'Content-Type': 'application/json'
  })
  expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
    key: AGENT_MAIL_CLOUD_STATE_KEY,
    value: JSON.stringify(state),
    valueType: 'json'
  })
})

it('fails closed for a stale identity and malformed service state', async () => {
  let identity = account('b', 'token-b')
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      key: AGENT_MAIL_CLOUD_STATE_KEY,
      value: JSON.stringify({ enabled: 'yes', phone: '13800138000' }),
      valueType: 'json'
    })
  )
  const client = new AgentMailCloudStateClient(() => identity, request)

  await expect(client.read(account('a', 'token-a'))).resolves.toEqual({ status: 'failed', reason: 'auth' })
  expect(request).not.toHaveBeenCalled()

  await expect(client.read(identity)).resolves.toEqual({ status: 'failed', reason: 'invalid-response' })
})
