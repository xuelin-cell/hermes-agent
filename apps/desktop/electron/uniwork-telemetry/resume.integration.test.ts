import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { expect, it } from 'vitest'

import { interruptedExecutionId } from '../entry_local/interrupted-turn-identity'

import { startTelemetryBridge } from './bridge'
import type { TelemetryInput } from './inputs'

const run = promisify(execFile)
const repo = path.resolve(import.meta.dirname, '../../../..')
const python = process.env.HERMES_PYTHON || path.join(repo, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

it('restores a closed execution across real process restarts and never promotes a crashed fragment into a whole turn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'UniWork-Resume-'))
  const home = path.join(root, 'AccountHome')
  const other = path.join(home, 'profiles', 'other')
  const empty = path.join(root, 'empty-bundled')
  fs.mkdirSync(empty)
  const events: Record<string, any>[] = []

  const upstream = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || !['/events', '/v1/chat/completions'].includes(request.url ?? '')) {
      response.writeHead(404).end()

      return
    }

    const chunks: Buffer[] = []

    for await (const chunk of request) { chunks.push(chunk) }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))

    if (request.url === '/events') {
      events.push(...body.events)
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 200,
        data: { results: body.events.map((_: unknown, index: number) => ({ index, status: 'accepted' })) } }))

      return
    }

    const user = body.messages.findLast((item: { role: string }) => item.role === 'user')?.content
    const pause = user === 'pause original'

    const calls = pause ? [{ id: 'route-call', type: 'function', function: { name: 'tool_call',
      arguments: JSON.stringify({ calls: [{ name: 'mcp__connector_amap__route', arguments: {} }] }) } }] : undefined

    const message = { role: 'assistant', content: pause ? null : 'done', ...(calls ? { tool_calls: calls } : {}) }

    const usage = { prompt_tokens: pause ? 10 : 7, completion_tokens: pause ? 3 : 2,
      prompt_tokens_details: { cached_tokens: pause ? 2 : 1 } }

    const common = { id: 'fixture', model: 'probe-model', created: Math.floor(Date.now() / 1000) }
    const finish = calls ? 'tool_calls' : 'stop'

    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })

      for (const chunk of [
        { ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { ...message,
          ...(calls ? { tool_calls: calls.map((call, index) => ({ ...call, index })) } : {}) }, finish_reason: null }] },
        { ...common, object: 'chat.completion.chunk', usage, choices: [{ index: 0, delta: {}, finish_reason: finish }] }
      ]) { response.write(`data: ${JSON.stringify(chunk)}\n\n`) }

      response.end('data: [DONE]\n\n')

      return
    }

    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...common,
      object: 'chat.completion', usage, choices: [{ index: 0, message, finish_reason: finish }] }))
  })

  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()

  if (!address || typeof address === 'string') { throw new Error('fixture unavailable') }
  const baseUrl = `http://127.0.0.1:${address.port}/v1`

  for (const target of [home, other]) {
    fs.cpSync(path.join(repo, 'apps/desktop/assets/usage-telemetry-plugin'), path.join(target, 'plugins/uniwork-telemetry'), { recursive: true })
    fs.writeFileSync(path.join(target, '.no-bundled-skills'), '')
    fs.writeFileSync(path.join(target, 'config.yaml'), JSON.stringify({ plugins: { enabled: ['uniwork-telemetry'] },
      providers: { [`desktop-mt-maas-${hash(baseUrl)}`]: { api: baseUrl, key_env: 'DESKTOP_MT_MAAS_API_KEY' } },
      ...(target === home ? { mcp_servers: { connector_amap: { command: python,
        args: [path.join(repo, 'tests/apps/desktop/fixtures/telemetry_mcp.py')], desktop_connector: 'amap',
        env: { TELEMETRY_MCP_LOG: path.join(target, 'mcp-calls.jsonl') } } } } : {}) }))
  }

  const bridge = await startTelemetryBridge({ home, endpoint: `http://127.0.0.1:${address.port}/events`,
    identity: () => ({ uid: 'fixture', token: `header.${Buffer.from(JSON.stringify({ id: 'fixture', application: 'uniwork' })).toString('base64url')}.fixture`,
      maskedPhone: 'fixture', expiresAt: Date.now() + 300_000 }), active: () => true, platform: process.platform, appVersion: 'test',
    plan: () => ({ status: 'available', plan: { apiKey: 'fixture-key', productId: 'plan', mainModelIndex: 0,
      models: [{ id: 'fixture-model', name: 'probe-model', displayName: 'Model', baseUrl }] } }) })

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:HERMES_|UNIWORK_TELEMETRY_|PYTHONPATH$|PYTHONHOME$|VIRTUAL_ENV$)/.test(key) &&
    !/_(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)$/.test(key)))

  let sequence = 0

  const execute = async (profile: string, phase: string, text: string, kind: TelemetryInput['requestKind'], resumeFrom?: string) => {
    const target = profile === 'default' ? home : other
    bridge.rememberInput({ id: `send-${++sequence}`, profile, sessionId: 'resume-session', requestHash: hash(text),
      requestKind: kind, resumeFrom, userInput: text })
    await run(python, [path.join(repo, 'tests/apps/desktop/fixtures/telemetry_resume_probe.py'), phase, text], {
      cwd: repo, windowsHide: true, timeout: 90_000, maxBuffer: 1024 * 1024,
      env: { ...env, ...bridge.env(target), HERMES_HOME: target, HERMES_BUNDLED_PLUGINS: empty,
        PYTHONPATH: repo, PYTHONUTF8: '1', DESKTOP_MT_MAAS_API_KEY: 'fixture-key' }
    })

    return JSON.parse(fs.readFileSync(path.join(target, 'resume-result.json'), 'utf8'))
  }

  const sourceId = (target: string) => interruptedExecutionId(target, 'resume-session',
    JSON.parse(fs.readFileSync(path.join(target, 'desktop/interrupted_turns.json'), 'utf8'))['resume-session'])!

  try {
    const paused = await execute('default', 'pause', 'pause original', 'user')
    expect(events.filter(event => event.eventName === 'conversation.turn.completed')).toHaveLength(0)
    const closed = await execute('default', 'resume', 'HIDDEN RESUME NOTE', 'resume', sourceId(home))
    const first = events.find(event => event.eventName === 'conversation.turn.completed')!
    expect(first.conversation).toMatchObject({ turnId: paused.checkpoint.logical_id, userInput: 'pause original',
      durationMs: closed.checkpoint.elapsed_ms })
    expect(first.occurredAt).toBe(paused.checkpoint.occurred_at)
    expect(first.usages[0]).toMatchObject({ inputTokens: 17, outputTokens: 5, cachedTokens: 3 })
    expect(closed.status.coverageGaps).toEqual({})

    await expect(execute('other', 'crash', 'crash original', 'user')).rejects.toMatchObject({ code: 99 })
    const incomplete = await execute('other', 'resume', 'HIDDEN CRASH CONTINUATION', 'resume', sourceId(other))
    expect(incomplete.status.coverageGaps.resume_incomplete).toBe(1)
    expect(incomplete.checkpoint.input_text).toBe('crash original')
    expect(events.filter(event => event.eventName === 'conversation.turn.completed')).toHaveLength(1)

    await execute('default', 'fresh', 'fresh original', 'user')
    const completed = events.filter(event => event.eventName === 'conversation.turn.completed')
    expect(completed).toHaveLength(2)
    expect(completed[1].conversation.userInput).toBe('fresh original')
    expect(completed[1].conversation.turnId).not.toBe(first.conversation.turnId)
    expect(JSON.stringify(events)).not.toContain('HIDDEN')
  } finally {
    await bridge.stop()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 180_000)
