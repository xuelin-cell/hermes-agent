/** One instance listener; each managed profile has its own encrypted store and MCP token. */
import { serve } from '@hono/node-server'
import { timingSafeEqual } from 'node:crypto'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import { CLOUD_CONNECTOR_IDS, CLOUD_CONNECTOR_SPECS } from './contract.ts'
import { connectorOAuth } from './oauth.ts'
import { ConnectorScopes, type ScopeOptions } from './profile-scopes.ts'

interface HostOptions extends ScopeOptions { port?: number }

export async function startConnectors(options: HostOptions) {
  const scopes = new ConnectorScopes(options)
  let active = 0
  const activityFile = path.join(options.home, '.mt', 'connectors-active.json')
  await mkdir(path.dirname(activityFile), { recursive: true, mode: 0o700 })
  const activity = () => {
    writeFileSync(`${activityFile}.tmp`, JSON.stringify({ pid: process.pid, active }), { mode: 0o600 })
    renameSync(`${activityFile}.tmp`, activityFile)
  }
  const authorized = (request: Request, token: string) => {
    const given = Buffer.from(request.headers.get('Authorization') ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
  const response = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
  const server = serve({ hostname: '127.0.0.1', port: options.port ?? 0, fetch: async request => {
    const url = new URL(request.url)
    const match = /^\/profiles\/([^/]+)(\/.*)$/.exec(url.pathname)
    let profile = 'default', route = url.pathname
    try {
      if (match) { profile = decodeURIComponent(match[1]); route = match[2] }
    } catch { return response({ error: 'Invalid profile' }, 400) }
    if (route === '/health' && profile === 'default' && authorized(request, options.admin)) return response({ ok: true })
    if (route === '/__manage' && profile === 'default' && request.method === 'POST' && authorized(request, options.admin)) {
      active++
      activity()
      try {
        if (existsSync(path.join(options.home, '.mt', 'connectors-draining')) || existsSync(path.join(options.home, '.mt', 'kits-active.json'))) return response({ error: 'Instance draining' }, 503)
        const input = await request.json() as { operation: string; id?: string; values?: Record<string, string>; origin?: string; parameters?: Record<string, string>; profile?: string }
        const scope = await scopes.get(input.profile ?? 'default')
        const { app, appOptions } = scope
        const spec = input.id && Object.hasOwn(CLOUD_CONNECTOR_SPECS, input.id) ? CLOUD_CONNECTOR_SPECS[input.id] : null
        if (input.operation !== 'list' && !spec) return response({ error: 'Unsupported connector' }, 400)
        if (['authorize', 'oauth.complete'].includes(input.operation)) {
          return response(await connectorOAuth(appOptions, input, request.signal))
        }
        if (input.operation === 'connect' && (spec!.auth === 'oauth2' || !input.values || Object.keys(input.values).length !== spec!.fields.length ||
          spec!.fields.some(field => typeof input.values?.[field] !== 'string' || !input.values[field].trim() || input.values[field].length > 16384))) {
          return response({ error: 'Invalid connector credentials' }, 400)
        }
        const routes = {
          list: { method: 'GET', path: '/api/connections' },
          connect: { method: 'PUT', path: `/api/connections/${input.id}` },
          disconnect: { method: 'DELETE', path: `/api/connections/${input.id}` }
        }
        const target = Object.hasOwn(routes, input.operation) ? routes[input.operation as keyof typeof routes] : null
        if (!target) return response({ error: 'Unsupported connector operation' }, 400)
        const result = await app.request(target.path, { method: target.method, signal: request.signal,
          headers: { Authorization: `Bearer ${scope.keys.admin}`, 'Content-Type': 'application/json' },
          ...(input.operation === 'connect' ? { body: JSON.stringify({ authType: spec!.auth, connectionName: 'default', values: input.values }) } : {}) })
        if (!result.ok) return response({ error: '连接器操作失败，请核对凭据或稍后查询状态。' }, 409)
        if (input.operation !== 'list') return response({ ok: true })
        const rows = await result.json() as { service: string; connectionName: string; configured: boolean }[]
        return response({ connectors: CLOUD_CONNECTOR_IDS.map(id => ({ id,
          configured: rows.some(row => row.service === id && row.connectionName === 'default' && row.configured) })) })
      } catch {
        return response({ error: '连接器请求失败，请核对凭据或稍后查询状态。' }, 409)
      } finally {
        active--
        activity()
      }
    }
    const id = route.startsWith('/mcp/') ? route.slice('/mcp/'.length) : ''
    const download = route.startsWith('/api/files/') && request.method === 'GET'
    if (!download && !Object.hasOwn(CLOUD_CONNECTOR_SPECS, id)) return response({ error: 'Unauthorized' }, 401)
    // Publish before checking the drain marker: the parent either observes a busy
    // operation, or this request observes the marker and never executes a tool.
    active++
    activity()
    try {
      if (existsSync(path.join(options.home, '.mt', 'connectors-draining')) || existsSync(path.join(options.home, '.mt', 'kits-active.json'))) return response({ error: 'Instance draining' }, 503)
      const scope = await scopes.get(profile)
      if (download) return scope.files.download(new Request(new URL(route + url.search, url.origin), request))
      if (!authorized(request, scope.keys.runtime)) return response({ error: 'Unauthorized' }, 401)
      try {
        // Check at every execution boundary, including old sessions retaining an MCP schema.
        const config = parse(await readFile(path.join(profile === 'default' ? options.home : path.join(options.home, 'profiles', profile), 'config.yaml'), 'utf8'))
        const saved = config?.mcp_servers?.[`connector_${id}`]
        if (saved?.cloud_connector !== id || saved.enabled !== true || (saved.cloud_connector_profile ?? 'default') !== profile) return response({ error: 'Connector disabled' }, 403)
      } catch {
        return response({ error: 'Connector unavailable' }, 403)
      }
      const headers = new Headers(request.headers)
      headers.set('X-OpenConnector-Allowed-Services', id)
      const result = await scope.app.fetch(new Request(new URL('/mcp', request.url), { method: request.method, headers,
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }), signal: request.signal }))
      // Drain the response while the operation remains busy; MCP responses are bounded by the existing service.
      return new Response(await result.arrayBuffer(), { status: result.status, headers: result.headers })
    } catch {
      return response({ error: 'Connector profile unavailable' }, 403)
    } finally {
      active--
      activity()
    }
  } })
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Connector listener unavailable')
  scopes.port = address.port
  return { port: address.port, close: async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    scopes.close()
  } }
}
