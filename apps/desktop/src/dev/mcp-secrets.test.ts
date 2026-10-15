import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
})

// A fresh module for every test: it remembers the masks it handed out.
const load = () => import('./mcp-secrets')

const KEY = 'sk-0123456789abcdefTAIL'
const PLATFORM_URL = `https://maas.example.com/app/mcp-server/mcp?key=${KEY}&client_id=UniWork&oss_mode=internal`
const MASKED_PLATFORM_URL =
  'https://maas.example.com/app/mcp-server/mcp?key=sk-••••••TAIL&client_id=UniWork&oss_mode=internal'

describe('keys on the MCP page', () => {
  it('masks the key in the platform server’s address and leaves the rest of the config alone', async () => {
    const { maskMcpSecrets } = await load()
    const record = { model: { default: 'm' }, mcp_servers: { yuanjing: { url: PLATFORM_URL, timeout: 300 } } }

    const masked = maskMcpSecrets('GET', '/api/config', record)

    expect(masked.mcp_servers.yuanjing).toEqual({ url: MASKED_PLATFORM_URL, timeout: 300 })
    expect(masked.model).toBe(record.model)
    expect(record.mcp_servers.yuanjing.url).toBe(PLATFORM_URL)
  })

  it('puts the key back when the page saves, so hermes keeps the reference it came from', async () => {
    const { maskMcpSecrets, restoreMcpSecrets } = await load()
    const masked = maskMcpSecrets('GET', '/api/config', { mcp_servers: { yuanjing: { url: PLATFORM_URL } } })

    // The mcp.json editor saves the whole map: here one server switched off, one added.
    const servers = { yuanjing: { ...masked.mcp_servers.yuanjing, enabled: false }, mine: { command: 'npx' } }

    expect(restoreMcpSecrets('PUT', '/api/mcp/servers', { servers })).toEqual({
      servers: { yuanjing: { url: PLATFORM_URL, enabled: false }, mine: { command: 'npx' } }
    })

    // Other settings pages save the whole record, the MCP servers with it.
    expect(restoreMcpSecrets('PUT', '/api/config', { config: { ...masked, display: { compact: true } } })).toEqual({
      config: { mcp_servers: { yuanjing: { url: PLATFORM_URL } }, display: { compact: true } }
    })
  })

  it('masks headers, environment values and arguments that hold credentials, and puts them all back', async () => {
    const { maskMcpSecrets, restoreMcpSecrets } = await load()

    const servers = {
      github: {
        command: 'npx',
        args: ['-y', '@x/server', '--api-key=ghp_0123456789abcdefARGS', '--token', 'short-token', '--port', '8080'],
        env: {
          GITHUB_TOKEN: 'ghp_0123456789abcdefGHUB',
          PATH: '/usr/bin',
          DATABASE_URL: 'postgres://app:hunter2@db:5432/x'
        }
      },
      remote: {
        url: 'https://user:p4ss@mcp.example.com/sse',
        headers: { Authorization: `Bearer ${KEY}`, 'X-API-Key': 'abc123', 'Content-Type': 'application/json' }
      }
    }

    const masked = maskMcpSecrets('GET', '/api/config', { mcp_servers: servers }).mcp_servers
    const shown = JSON.stringify(masked)

    for (const secret of [
      'ghp_0123456789abcdefARGS',
      'short-token',
      'ghp_0123456789abcdefGHUB',
      'hunter2',
      'p4ss',
      KEY,
      'abc123'
    ]) {
      expect(shown).not.toContain(secret)
    }

    expect(masked.github.args.slice(0, 4)).toEqual(['-y', '@x/server', '--api-key=ghp_••••••ARGS', '--token'])
    expect(masked.github.args.slice(5)).toEqual(['--port', '8080'])
    expect(masked.github.env.GITHUB_TOKEN).toBe('ghp_••••••GHUB')
    expect(masked.github.env.PATH).toBe('/usr/bin')
    expect(masked.github.env.DATABASE_URL).toMatch(/^postgres:\/\/app:•{6,}@db:5432\/x$/)
    expect(masked.remote.url).toMatch(/^https:\/\/user:•{6,}@mcp\.example\.com\/sse$/)
    expect(masked.remote.headers.Authorization).toBe('Bearer sk-••••••TAIL')
    expect(masked.remote.headers['Content-Type']).toBe('application/json')

    expect(restoreMcpSecrets('PUT', '/api/mcp/servers', { servers: masked })).toEqual({ servers })
  })

  it('tells apart two keys that would look alike and puts each one back', async () => {
    const { maskMcpSecrets, restoreMcpSecrets } = await load()

    const servers = {
      a: { url: 'https://a.example.com/mcp?key=sk-AAAAAAAAAAAAAAAAsame', headers: { 'X-API-Key': 'one' } },
      b: { url: 'https://b.example.com/mcp?key=sk-BBBBBBBBBBBBBBBBsame', headers: { 'X-API-Key': 'two' } }
    }

    const masked = maskMcpSecrets('GET', '/api/config', { mcp_servers: servers }).mcp_servers

    expect(masked.a.url).not.toBe(masked.b.url.replace('b.example', 'a.example'))
    expect(masked.a.headers['X-API-Key']).not.toBe(masked.b.headers['X-API-Key'])

    // Swapped between servers in the editor: each key goes where its mask went.
    const swapped = { a: { ...masked.a, headers: masked.b.headers }, b: { ...masked.b, headers: masked.a.headers } }

    expect(restoreMcpSecrets('PUT', '/api/mcp/servers', { servers: swapped }).servers).toEqual({
      a: { ...servers.a, headers: servers.b.headers },
      b: { ...servers.b, headers: servers.a.headers }
    })
  })

  it('shows the same mask every time it reads the same key', async () => {
    const { maskMcpSecrets } = await load()
    const read = () => maskMcpSecrets('GET', '/api/config', { mcp_servers: { yuanjing: { url: PLATFORM_URL } } })

    expect(read()).toEqual(read())
  })

  it('leaves unset references and empty values alone', async () => {
    const { maskMcpSecrets } = await load()

    const record = {
      mcp_servers: {
        x: {
          url: 'https://x.example.com/mcp?key=${MISSING_KEY}&token=&client_id=UniWork',
          headers: { Authorization: 'Bearer ${MCP_X_API_KEY}' },
          env: { API_KEY: '' }
        }
      }
    }

    expect(maskMcpSecrets('GET', '/api/config', record)).toEqual(record)
  })

  it('refuses to save a mask it never handed out rather than replace the key with dots', async () => {
    const { restoreMcpSecrets } = await load()
    const servers = { x: { url: 'https://x.example.com/mcp?key=sk-••••••TAIL' } }

    expect(() => restoreMcpSecrets('PUT', '/api/mcp/servers', { servers })).toThrow(/out of date|过期/)
  })

  it('masks the server list and the server that adding one answers with', async () => {
    const { maskMcpSecrets, restoreMcpSecrets } = await load()

    const list = maskMcpSecrets('GET', '/api/mcp/servers', { servers: [{ name: 'yuanjing', url: PLATFORM_URL }] })

    expect(list.servers[0].url).toBe(MASKED_PLATFORM_URL)

    const added = maskMcpSecrets('POST', '/api/mcp/servers?profile=default', { name: 'copy', url: PLATFORM_URL })

    expect(added.url).toBe(MASKED_PLATFORM_URL)
    expect(restoreMcpSecrets('POST', '/api/mcp/servers', { name: 'copy', url: added.url })).toEqual({
      name: 'copy',
      url: PLATFORM_URL
    })
  })

  it('passes every other call through untouched', async () => {
    const { maskMcpSecrets, restoreMcpSecrets } = await load()
    const env = { YUANJING_API_KEY: { is_set: true, redacted_value: 'sk-0…TAIL' } }
    const settings = { config: { display: { compact: true } } }
    const toggle = { enabled: false }

    expect(maskMcpSecrets('GET', '/api/env', env)).toBe(env)
    expect(maskMcpSecrets('PUT', '/api/config', { ok: true })).toEqual({ ok: true })
    expect(restoreMcpSecrets('PUT', '/api/config', settings)).toBe(settings)
    expect(restoreMcpSecrets('PUT', '/api/mcp/servers/yuanjing/enabled', toggle)).toBe(toggle)
  })
})
