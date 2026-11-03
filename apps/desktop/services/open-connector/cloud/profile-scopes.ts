/** One Node process, separate encrypted stores and execution tokens per managed profile. */
import { readFile, realpath, lstat } from 'node:fs/promises'
import { chmod, mkdir } from 'node:fs/promises'
import path from 'node:path'
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
import { CLOUD_CONNECTOR_IDS } from './contract.ts'
import { ConnectorFiles } from './files.ts'
import { createCatalogStore } from '../src/catalog-store.ts'
import { ProviderLoader } from '../src/providers/provider-loader.ts'
import type { IProviderLoader } from '../src/providers/provider-loader.ts'
import type { ProviderDefinition } from '../src/core/types.ts'
import { createConnectApp } from '../src/server/connect-app.ts'
import { AesGcmSecretCodec } from '../src/server/secrets/secret-codec.ts'
import { SqliteRuntimeDatabase } from '../src/server/storage/sqlite-runtime-store.ts'


export interface ScopeOptions {
  home: string
  encryption: string
  admin: string
  runtime: string
  providerLoader?: IProviderLoader
  profileToken?: string
  backendPort?: number
}
interface Keys { encryption: string; admin: string; runtime: string }

async function buildScope(home: string, keys: Keys, options: ScopeOptions) {
  const directory = path.join(home, 'open-connector')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const secretCodec = new AesGcmSecretCodec(keys.encryption)
  const database = new SqliteRuntimeDatabase(path.join(directory, 'connect.sqlite'), { secretCodec })
  await chmod(path.join(directory, 'connect.sqlite'), 0o600)
  const providers = [amap, youdao, wps, wecom, ima, qqMail, neteaseMail, aminer, qcc, eastmoney, ifind] as ProviderDefinition[]
  const catalog = createCatalogStore(providers, { executableActionIds: providers.flatMap(provider => provider.actions.map(action => action.id)) })
  const files = new ConnectorFiles(path.join(directory, 'files'), keys.runtime)
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
    publicOrigin: 'http://127.0.0.1', adminToken: keys.admin, runtimeToken: keys.runtime,
    mcpAllowedServices: new Set(CLOUD_CONNECTOR_IDS)
  }
  const { app } = await createConnectApp(appOptions)
  return { app, appOptions, files, keys, database }
}

export class ConnectorScopes {
  private cached = new Map<string, { stamp: string; scope: Awaited<ReturnType<typeof buildScope>> }>()
  private pending = new Map<string, Promise<Awaited<ReturnType<typeof buildScope>>>>()
  port = 0
  constructor(private readonly options: ScopeOptions) {}

  async get(profile: string) {
    if (!profile || profile.startsWith('.') || /[\\/]/.test(profile) || profile.length > 160) throw new Error('Invalid profile')
    if (profile !== 'default') {
      if (!this.options.profileToken) throw new Error('Expert connectors unavailable')
      const response = await fetch(`http://127.0.0.1:${this.options.backendPort ?? 9120}/api/plugins/uniwork-kits/cloud/connector-profile?name=${encodeURIComponent(profile)}`, {
        headers: { 'X-Hermes-Session-Token': this.options.profileToken }, signal: AbortSignal.timeout(10_000), redirect: 'error'
      })
      if (!response.ok || (await response.json() as { profile?: string }).profile !== profile) throw new Error('Expert is not active')
    }
    const home = profile === 'default' ? this.options.home : path.join(this.options.home, 'profiles', profile)
    if (profile !== 'default' && (await realpath(home) !== path.join(await realpath(this.options.home), 'profiles', profile) || (await lstat(path.join(this.options.home, 'profiles'))).isSymbolicLink())) throw new Error('Invalid expert directory')
    const keyFile = path.join(home, 'open-connector/secrets.json')
    if ((await lstat(path.join(home, 'open-connector'))).isSymbolicLink() || (await lstat(keyFile)).isSymbolicLink()) throw new Error('Invalid connector keys')
    const contents = await readFile(keyFile, 'utf8')
    const keys: Keys = profile === 'default' ? this.options : JSON.parse(contents)
    if (['encryption', 'admin', 'runtime'].some(key => typeof keys[key as keyof Keys] !== 'string' || keys[key as keyof Keys].length !== 64)) throw new Error('Invalid connector keys')
    const stamp = `${(await lstat(home)).ino}:${contents}`
    const existing = this.cached.get(profile)
    if (existing?.stamp === stamp) return existing.scope
    const running = this.pending.get(profile)
    if (running) return running
    const initialization = (async () => {
      existing?.scope.database.close()
      this.cached.delete(profile)
      const scope = await buildScope(home, keys, this.options)
      const prefix = profile === 'default' ? '' : '/profiles/' + encodeURIComponent(profile)
      scope.files.origin = `http://127.0.0.1:${this.port}${prefix}`
      this.cached.set(profile, { stamp, scope })
      return scope
    })()
    this.pending.set(profile, initialization)
    try { return await initialization } finally { this.pending.delete(profile) }
  }

  close() {
    for (const entry of this.cached.values()) entry.scope.database.close()
    this.cached.clear()
  }
}
