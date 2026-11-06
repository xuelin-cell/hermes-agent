import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'
import { parse } from 'yaml'

import { createLocalSecretStorage } from '../local-secret-storage'

import { ConnectorManager } from './manager'
import { ConnectorRuntime, connectorRequestTimeoutMs } from './runtime'

it('provides the four-minute mailbox credential-validation request budget', () => {
  expect(connectorRequestTimeoutMs).toBe(240_000)
})

it('真实共享进程为多个助手提供同一端点，关闭账号后端点不可访问', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-shared-runtime-'))
  const storage = createLocalSecretStorage(path.join(home, 'app-secret.key'))

  const manager = new ConnectorManager({
    home, profiles: () => ['default', 'expert-a', 'expert-b'], active: () => true, identity: () => null,
    runtimeDirectory: path.resolve('services/open-connector'),
    executable: createRequire(import.meta.url)('electron'),
    encrypt: value => storage.encryptString(value), decrypt: value => storage.decryptString(value),
    api: async () => ({ mcp_servers: {} }), openExternal: async () => undefined, log: () => undefined,
    mailState: { get: () => null, save: () => undefined },
    saveAttachment: async () => ({ canceled: true, saved: false }),
    stageAttachment: async () => { throw new Error('unused') }
  })

  const endpoints: string[] = []

  try {
    for (const profile of ['default', 'expert-a', 'expert-b']) {
      const target = profile === 'default' ? home : path.join(home, 'profiles', profile)
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(path.join(target, 'config.yaml'),
        'mcp_servers:\n  connector_amap:\n    desktop_connector: amap\n    enabled: true\n')
    }

    await manager.start()
    await Promise.all(['default', 'expert-a', 'expert-b'].map(profile => manager.prepare(profile)))

    for (const profile of ['default', 'expert-a', 'expert-b']) {
      const target = profile === 'default' ? home : path.join(home, 'profiles', profile)
      const entry = parse(fs.readFileSync(path.join(target, 'config.yaml'), 'utf8')).mcp_servers.connector_amap
      endpoints.push(entry.url)
      expect(entry.enabled).toBe(false)
      expect(fs.existsSync(path.join(target, 'open-connector'))).toBe(profile === 'default')
      await manager.request({ operation: 'list', profile })
    }

    expect(new Set(endpoints).size).toBe(1)
    expect((await fetch(endpoints[0].replace('/mcp', '/health'))).ok).toBe(true)
  } finally {
    await manager.close()

    if (endpoints.length) {await expect(fetch(endpoints[0])).rejects.toThrow()}

    fs.rmSync(home, { recursive: true, force: true })
  }
}, 60_000)

it('runs isolated services A → B → A with authenticated, service-filtered MCP discovery', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-connectors-'))

  const storage = createLocalSecretStorage(path.join(directory, 'app-secret.key'))
  fs.mkdirSync(path.join(directory, 'A'))
  fs.writeFileSync(path.join(directory, 'A', 'secrets.enc'), 'legacy-keychain-ciphertext')
  fs.writeFileSync(path.join(directory, 'A', 'connect.sqlite'), 'legacy-db')

  const make = (profile: string) =>
    new ConnectorRuntime({
      directory: path.join(directory, profile),
      runtimeDirectory: path.resolve('services/open-connector'),
      executable: createRequire(import.meta.url)('electron'),
      encrypt: value => storage.encryptString(value),
      decrypt: value => storage.decryptString(value)
    })

  const a = make('A'),
    b = make('B')

  let endpoint = ''

  try {
    const first = await a.config('amap')
    expect(fs.readFileSync(path.join(directory, 'A', 'legacy-keychain-backup', 'connect.sqlite'), 'utf8')).toBe('legacy-db')
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
