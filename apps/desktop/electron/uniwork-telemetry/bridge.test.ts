import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import type { LoginIdentity } from '../login/session'

import { startTelemetryBridge, telemetryAccount, telemetryEnabled } from './bridge'

function identity(id: string): LoginIdentity {
  return { uid: id, token: `header.${Buffer.from(JSON.stringify({ id, application: 'uniwork' })).toString('base64url')}.fixture`,
    expiresAt: Date.now() - 60_000, maskedPhone: 'fixture' }
}

it('real forwarding preserves int64 and account/profile isolation while the server decides token validity', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uniwork-telemetry-'))
  const received: { body: string; authorization: string | undefined }[] = []
  let upstreamStatus = 200

  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []

    for await (const chunk of request) {chunks.push(chunk)}
    received.push({ body: Buffer.concat(chunks).toString('utf8'), authorization: request.headers.authorization })
    response.writeHead(upstreamStatus, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ code: 200, data: { results: [{ index: 0, status: 'accepted' }] } }))
  })

  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()

  if (!upstreamAddress || typeof upstreamAddress === 'string') {throw new Error('fixture unavailable')}
  const endpoint = `http://127.0.0.1:${upstreamAddress.port}/events`
  let current: LoginIdentity | null = identity('a')

  const bridge = await startTelemetryBridge({ home, endpoint, identity: () => current, active: () => true,
    appVersion: 'test', platform: process.platform,
    plan: () => ({ status: 'available', plan: { apiKey: 'model-key', productId: 'product-a', productName: '套餐',
      models: [{ id: 'local-uuid', name: 'model-a', displayName: '模型 A', baseUrl: 'https://model.invalid/v1' }], mainModelIndex: 0 } }) })

  try {
    const env = bridge.env(home)
    expect(env.UNIWORK_TELEMETRY_CONTEXT).toBeDefined()
    const initial = JSON.parse(env.UNIWORK_TELEMETRY_CONTEXT)
    expect(initial.account).toBe(telemetryAccount(current, endpoint))
    expect(initial.models[0]).toMatchObject({ modelId: 'model-a', modelName: '模型 A', productId: 'product-a',
      credential: createHash('sha256').update('model-key').digest('hex') })
    expect(env.UNIWORK_TELEMETRY_CONTEXT).not.toContain(current.token)
    expect(env.UNIWORK_TELEMETRY_CONTEXT).not.toContain('model-key')

    const headers = { Authorization: `Bearer ${env.UNIWORK_TELEMETRY_TOKEN}`, 'Content-Type': 'application/json',
      'X-UniWork-Account': initial.account }

    const body = '{"events":[{"eventName":"conversation.turn.completed","conversation":{"durationMs":9223372036854775807}}]}'
    const send = () => fetch(`${env.UNIWORK_TELEMETRY_BRIDGE}/batch`, { method: 'POST', headers, body })
    expect((await (await send()).json()).body.code).toBe(200)
    expect(received).toEqual([{ body, authorization: `Bearer ${current.token}` }])
    current = identity('b')
    expect((await send()).status).toBe(401)
    current = identity('a')
    const profile = path.join(home, 'profiles', 'expert')
    fs.mkdirSync(profile, { recursive: true })
    const profileSpelling = process.platform === 'win32' ? profile.toLowerCase() : profile
    const profileHeaders = { ...headers, 'X-UniWork-Profile': Buffer.from(profileSpelling).toString('hex') }
    const requestHash = createHash('sha256').update('expert input').digest('hex')
    bridge.rememberInput({ id: 'expert-send', profile: 'expert', sessionId: 'expert-session', requestHash, requestKind: 'user', userInput: 'expert input' })

    const correlated = await fetch(`${env.UNIWORK_TELEMETRY_BRIDGE}/input`, { method: 'POST', headers: profileHeaders,
      body: JSON.stringify({ requestHash, turnId: 'expert-turn', sessionId: 'expert-session' }) })

    expect(await correlated.json()).toEqual({ submissionId: 'expert-send', requestKind: 'user', userInput: 'expert input' })
    fs.writeFileSync(path.join(profile, 'config.yaml'), 'plugins:\n  entries:\n    uniwork-telemetry:\n      settings:\n        enabled: false\n')

    const profileResponse = await fetch(`${env.UNIWORK_TELEMETRY_BRIDGE}/batch`, { method: 'POST',
      headers: profileHeaders, body })

    expect(profileResponse.status).toBe(403)
    expect(telemetryEnabled(home)).toBe(true)
    expect(telemetryEnabled(profile)).toBe(false)
    expect(received).toHaveLength(1)
    expect((await send()).status).toBe(200)
    expect(received).toHaveLength(2)
    expect(() => bridge.env(path.join(home, '..', 'another-account'))).toThrow()
    upstreamStatus = 401
    expect((await (await send()).json()).status).toBe(401)
    current = null
    expect((await send()).status).toBe(401)
  } finally {
    await bridge.stop()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    fs.rmSync(home, { recursive: true, force: true })
  }
})
