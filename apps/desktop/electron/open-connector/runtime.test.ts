import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import { ConnectorRuntime } from './runtime'

it('runs isolated services A → B → A with authenticated, service-filtered MCP discovery', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-connectors-'))

  const make = (profile: string) =>
    new ConnectorRuntime({
      directory: path.join(directory, profile),
      runtimeDirectory: path.resolve('services/open-connector'),
      executable: createRequire(import.meta.url)('electron'),
      encrypt: value => Buffer.from(value),
      decrypt: value => value.toString()
    })

  const a = make('A'),
    b = make('B')

  let endpoint = ''

  try {
    const first = await a.config('amap')
    endpoint = first.url as string
    const second = await b.config('qq_mail')
    expect(first.url).not.toBe(second.url)
    expect(first.headers).not.toEqual(second.headers)
    expect(await a.rows()).toEqual(await b.rows())
    expect(await a.config('amap')).toEqual(first)
    expect(
      (
        await fetch(first.url as string, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        })
      ).status
    ).toBe(401)

    const response = await fetch(first.url as string, {
      method: 'POST',
      headers: {
        ...(first.headers as Record<string, string>),
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'hermes-desktop-test', version: '1' }
        }
      })
    })

    expect(response.ok, await response.clone().text()).toBe(true)
    expect(await response.text()).toContain('serverInfo')

    const call = async (method: string, params?: unknown) => {
      const result = await fetch(first.url as string, {
        method: 'POST',
        headers: {
          ...(first.headers as Record<string, string>),
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params })
      })

      expect(result.ok).toBe(true)
      const text = await result.text()

      return JSON.parse(
        text.startsWith('event:') || text.startsWith('data:')
          ? text
              .split('\n')
              .find(line => line.startsWith('data:'))!
              .slice(5)
          : text
      )
    }

    const tools = await call('tools/list')
    expect(tools.result.tools.map(tool => tool.name)).toContain('execute_action')
    const apps = await call('tools/call', { name: 'list_apps', arguments: {} })
    expect(JSON.stringify(apps)).toContain('amap')
    expect(JSON.stringify(apps)).not.toContain('qq_mail')
    expect(
      (
        await fetch((first.url as string).replace('/mcp', '/api/connections'), {
          headers: { Authorization: (first.headers as Record<string, string>).Authorization }
        })
      ).status
    ).toBe(401)
  } finally {
    await Promise.all([a.close(), b.close()])

    if (endpoint) {
      await expect(fetch(endpoint)).rejects.toThrow()
    }

    fs.rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)
