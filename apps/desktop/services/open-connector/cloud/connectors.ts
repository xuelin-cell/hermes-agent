/** Instance-local connector host. Only the private manager and scoped MCP are exposed. */
import { serve } from '@hono/node-server'
import { timingSafeEqual } from 'node:crypto'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import amap from '../catalog/apps/amap.json'
import youdao from '../catalog/apps/youdao_note.json'
import wps from '../catalog/apps/wps_mcp.json'
import wecom from '../catalog/apps/wecom_bot.json'
import ima from '../catalog/apps/ima.json'
import qqMail from '../catalog/apps/qq_mail.json'
import neteaseMail from '../catalog/apps/netease_mail.json'
import aminer from '../catalog/apps/aminer.json'
import qcc from '../catalog/apps/qcc_mcp.json'
import eastmoney from '../catalog/apps/eastmoney_mcp.json'
import ifind from '../catalog/apps/ifind_mcp.json'
import { CLOUD_CONNECTOR_IDS, CLOUD_CONNECTOR_SPECS } from './contract.ts'
import { connectorOAuth } from './oauth.ts'
import { ConnectorFiles } from './files.ts'
import { createCatalogStore } from '../src/catalog-store.ts'
import { ProviderLoader } from '../src/providers/provider-loader.ts'
import type { IProviderLoader } from '../src/providers/provider-loader.ts'
import type { ProviderDefinition } from '../src/core/types.ts'
import { createConnectApp } from '../src/server/connect-app.ts'
import { AesGcmSecretCodec } from '../src/server/secrets/secret-codec.ts'
import { SqliteRuntimeDatabase } from '../src/server/storage/sqlite-runtime-store.ts'

interface HostOptions {
  home: string
  encryption: string
  admin: string
  runtime: string
  port?: number
  providerLoader?: IProviderLoader
}

export async function startConnectors(options: HostOptions) {
  const directory = path.join(options.home, 'open-connector')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const secretCodec = new AesGcmSecretCodec(options.encryption)
  const database = new SqliteRuntimeDatabase(path.join(directory, 'connect.sqlite'), { secretCodec })
  await chmod(path.join(directory, 'connect.sqlite'), 0o600)
  const providers = [amap, youdao, wps, wecom, ima, qqMail, neteaseMail, aminer, qcc, eastmoney, ifind] as ProviderDefinition[]
  const catalog = createCatalogStore(providers, { executableActionIds: providers.flatMap(provider => provider.actions.map(action => action.id)) })
  const files = new ConnectorFiles(path.join(directory, 'files'), options.runtime)
  const appOptions = {
    catalog, secretCodec, runtimeDatabase: database,
    providerLoader: options.providerLoader ?? new ProviderLoader({
      amap: () => import('../src/providers/amap/executors.ts'),
      youdao_note: () => import('../src/providers/youdao_note/executors.ts'),
      wps_mcp: () => import('../src/providers/wps_mcp/executors.ts'),
      wecom_bot: () => import('../src/providers/wecom_bot/executors.ts'),
      ima: () => import('../src/providers/ima/executors.ts'),
      qq_mail: () => import('../src/providers/qq_mail/executors.ts'),
      netease_mail: () => import('../src/providers/netease_mail/executors.ts'),
      aminer: () => import('../src/providers/aminer/executors.ts'),
      qcc_mcp: () => import('../src/providers/qcc_mcp/executors.ts'),
      eastmoney_mcp: () => import('../src/providers/eastmoney_mcp/executors.ts'),
      ifind_mcp: () => import('../src/providers/ifind_mcp/executors.ts')
    }),
    transitFiles: files,
    publicOrigin: 'http://127.0.0.1', adminToken: options.admin, runtimeToken: options.runtime,
    mcpAllowedServices: new Set(CLOUD_CONNECTOR_IDS)
  }
  const { app } = await createConnectApp(appOptions)
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
    const route = new URL(request.url).pathname
    if (route === '/health' && authorized(request, options.admin)) return response({ ok: true })
    if (route.startsWith('/api/files/') && request.method === 'GET') return files.download(request)
    if (route === '/__manage' && request.method === 'POST' && authorized(request, options.admin)) {
      active++
      activity()
      try {
        if (existsSync(path.join(options.home, '.mt', 'connectors-draining'))) return response({ error: 'Instance draining' }, 503)
        const input = await request.json() as { operation: string; id?: string; values?: Record<string, string>; origin?: string; parameters?: Record<string, string> }
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
          headers: { Authorization: `Bearer ${options.admin}`, 'Content-Type': 'application/json' },
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
    if (!Object.hasOwn(CLOUD_CONNECTOR_SPECS, id) || !authorized(request, options.runtime)) return response({ error: 'Unauthorized' }, 401)
    // Publish before checking the drain marker: the parent either observes a busy
    // operation, or this request observes the marker and never executes a tool.
    active++
    activity()
    try {
      if (existsSync(path.join(options.home, '.mt', 'connectors-draining'))) return response({ error: 'Instance draining' }, 503)
      try {
        // Check at every execution boundary, including old sessions retaining an MCP schema.
        const config = parse(await readFile(path.join(options.home, 'config.yaml'), 'utf8'))
        const saved = config?.mcp_servers?.[`connector_${id}`]
        if (saved?.cloud_connector !== id || saved.enabled !== true) return response({ error: 'Connector disabled' }, 403)
      } catch {
        return response({ error: 'Connector unavailable' }, 403)
      }
      const headers = new Headers(request.headers)
      headers.set('X-OpenConnector-Allowed-Services', id)
      const result = await app.fetch(new Request(new URL('/mcp', request.url), { method: request.method, headers,
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }), signal: request.signal }))
      // Drain the response while the operation remains busy; MCP responses are bounded by the existing service.
      return new Response(await result.arrayBuffer(), { status: result.status, headers: result.headers })
    } finally {
      active--
      activity()
    }
  } })
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Connector listener unavailable')
  files.origin = `http://127.0.0.1:${address.port}`
  return { port: address.port, close: async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    database.close()
  } }
}
