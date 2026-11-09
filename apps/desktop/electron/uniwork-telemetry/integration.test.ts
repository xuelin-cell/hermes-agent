import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { expect, it } from 'vitest'
import { parse } from 'yaml'

import { updateUniaiToolkitConfig } from '../entry_local/uniai-toolkit-config'

import { startTelemetryBridge } from './bridge'

const run = promisify(execFile)
const repo = path.resolve(import.meta.dirname, '../../../..')
const python = process.env.HERMES_PYTHON || path.join(repo, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

it('real plugin commands and MCP calls deliver tags, successful capabilities and a completed turn through the bridge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'UniWork-Telemetry-Bridge-'))
  const home = path.join(root, 'AccountHome')
  const empty = path.join(root, 'empty-bundled')
  fs.mkdirSync(empty)
  fs.cpSync(path.join(repo, 'apps/desktop/assets/usage-telemetry-plugin'), path.join(home, 'plugins/uniwork-telemetry'), { recursive: true })
  fs.writeFileSync(path.join(home, '.no-bundled-skills'), '')
  const events: Record<string, any>[] = []

  const upstream = http.createServer(async (request, response) => {
    // Agent initialization may probe model-discovery endpoints. This fixture implements only the calls below.
    if (request.method !== 'POST' || !['/events', '/v1/chat/completions'].includes(request.url ?? '')) {
      response.writeHead(404).end()

      return
    }

    const chunks: Buffer[] = []

    for await (const chunk of request) {chunks.push(chunk)}
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))

    if (request.url === '/events') {
      events.push(...body.events)
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        code: 200, data: { results: body.events.map((_: unknown, index: number) => ({ index, status: 'accepted' })) }
      }))

      return
    }

    const common = { id: 'fixture-completion', model: 'probe-model', created: Math.floor(Date.now() / 1000) }
    const usage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 3 } }

    const toolCalls = body.messages.some((message: { role: string }) => message.role === 'tool') ? undefined : [
      { id: 'toolkit-ok', name: 'mcp__UniAI_Toolkit__txt2img_generate', arguments: { fail: false } },
      { id: 'toolkit-failed', name: 'mcp__UniAI_Toolkit__txt2img_generate', arguments: { fail: true } },
      { id: 'connector-ok', name: 'mcp__connector_amap__route', arguments: {} }
    ].map(call => ({ id: call.id, type: 'function', function: { name: 'tool_call',
      arguments: JSON.stringify({ calls: [{ name: call.name, arguments: call.arguments }] }) } }))

    const finish = toolCalls ? 'tool_calls' : 'stop'
    const message = { role: 'assistant', content: toolCalls ? null : 'received', ...(toolCalls ? { tool_calls: toolCalls } : {}) }

    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })

      for (const chunk of [
        { ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { ...message,
          ...(toolCalls ? { tool_calls: toolCalls.map((tool, index) => ({ ...tool, index })) } : {}) }, finish_reason: null }] },
        { ...common, object: 'chat.completion.chunk', usage, choices: [{ index: 0, delta: {}, finish_reason: finish }] }
      ]) {response.write(`data: ${JSON.stringify(chunk)}\n\n`)}

      response.end('data: [DONE]\n\n')

      return
    }

    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      ...common, object: 'chat.completion', usage,
      choices: [{ index: 0, message, finish_reason: finish }]
    }))
  })

  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()

  if (!address || typeof address === 'string') {throw new Error('fixture did not bind')}
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const provider = `desktop-mt-maas-${createHash('sha256').update(baseUrl).digest('hex')}`
  updateUniaiToolkitConfig(home, 'available')
  const builtinId = parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).mcp_servers['UniAI-Toolkit'].uniwork_builtin_id
  const mcpFixture = path.join(repo, 'tests/apps/desktop/fixtures/telemetry_mcp.py')
  fs.writeFileSync(path.join(home, 'config.yaml'), JSON.stringify({
    plugins: { enabled: ['uniwork-telemetry'] },
    providers: { [provider]: { api: baseUrl, key_env: 'DESKTOP_MT_MAAS_API_KEY' } },
    mcp_servers: {
      'UniAI-Toolkit': { command: python, args: [mcpFixture], uniwork_builtin_id: builtinId,
        env: { TELEMETRY_MCP_LOG: path.join(home, 'toolkit-calls.jsonl') } },
      connector_amap: { command: python, args: [mcpFixture], desktop_connector: 'amap',
        env: { TELEMETRY_MCP_LOG: path.join(home, 'connector-calls.jsonl') } }
    }
  }))

  const identity = { uid: 'fixture', token: `header.${Buffer.from(JSON.stringify({ id: 'fixture', application: 'uniwork' })).toString('base64url')}.signature`,
    maskedPhone: 'fixture', expiresAt: Date.now() + 300_000 }

  const bridge = await startTelemetryBridge({ home, endpoint: `http://127.0.0.1:${address.port}/events`,
    identity: () => identity, active: () => true, platform: process.platform, appVersion: 'test',
    plan: () => ({ status: 'available', plan: { apiKey: 'fixture-model-key', productId: 'fixture-plan', mainModelIndex: 0,
      models: [{ id: 'local-configuration-id', name: 'probe-model', displayName: 'Probe Model', baseUrl }] } }) })

  try {
    bridge.rememberInput({ id: 'probe-send', profile: 'default', sessionId: 'telemetry-probe-session', requestKind: 'user',
      requestHash: createHash('sha256').update('bridge migration probe').digest('hex'), userInput: 'bridge migration probe' })

    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:HERMES_|UNIWORK_TELEMETRY_|PYTHONPATH$|PYTHONHOME$|VIRTUAL_ENV$)/.test(key) &&
      !/_(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)$/.test(key)))

    await run(python, [path.join(repo, 'tests/apps/desktop/fixtures/telemetry_probe.py')], {
      cwd: repo, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { ...env, ...bridge.env(home), HERMES_HOME: home, HERMES_BUNDLED_PLUGINS: empty,
        PYTHONPATH: repo, PYTHONUTF8: '1', DESKTOP_MT_MAAS_API_KEY: 'fixture-model-key' }
    })

    expect(JSON.parse(fs.readFileSync(path.join(home, 'probe-result.json'), 'utf8'))).toMatchObject({
      telemetry_probe: 'passed', status: { delivery: 200, events: { sent: 4 }, dropped: 0 }
    })
    expect(events).toHaveLength(4)
    expect(events.find(event => event.eventName === 'conversation.turn.completed')).toMatchObject({ eventName: 'conversation.turn.completed', conversation: {
      sessionId: 'telemetry-probe-session', userInput: 'bridge migration probe'
    }, usages: [{ modelId: 'probe-model', productId: 'fixture-plan', inputTokens: 24, outputTokens: 8, cachedTokens: 6 }] })
    const subjects = events.filter(event => event.eventName === 'capability.invoke').map(event => event.subject)
    expect(subjects).toEqual(expect.arrayContaining([
      { type: 'skill_tag', id: 'server-writing-ABC', name: '帮我写作' },
      { type: 'mcp', id: `builtin:${builtinId}`, name: 'UniAI-Toolkit', tool: 'txt2img_generate' },
      { type: 'mcp', id: 'connector:amap', tool: 'route' }
    ]))
    expect(events.filter(event => event.eventName === 'capability.invoke').every(event => !event.plugin && !event.usageId)).toBe(true)
    const toolkitCalls = fs.readFileSync(path.join(home, 'toolkit-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(toolkitCalls).toEqual(expect.arrayContaining([{ tool: 'txt2img_generate', fail: false }, { tool: 'txt2img_generate', fail: true }]))
    expect(toolkitCalls).toHaveLength(2)
    expect(JSON.parse(fs.readFileSync(path.join(home, 'connector-calls.jsonl'), 'utf8').trim())).toEqual({ tool: 'route' })
  } finally {
    await bridge.stop()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 150_000)
