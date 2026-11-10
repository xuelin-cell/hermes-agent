import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { parse } from 'yaml'

import { currentExecutionId } from '../entry_local/interrupted-turn-identity'
import type { FetchedPlan } from '../login/plan'
import type { LoginIdentity } from '../login/session'

import { type TelemetryInput, TelemetryInputs } from './inputs'

const ENDPOINT = 'https://maas.ai-yuanjing.com/app/gateway/analytics/events/batch'
const MAX_BYTES = 256 * 1024
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export interface TelemetryBridgeOptions {
  home: string
  identity: () => LoginIdentity | null
  plan: () => FetchedPlan
  active: () => boolean
  appVersion: string
  platform: NodeJS.Platform
  request?: typeof fetch
  endpoint?: string
}

interface Binding { home: string; account: string }

/** Only the trusted desktop login supplies credentials. Decoding partitions the queue; MaaS authenticates. */
export function telemetryAccount(identity: LoginIdentity | null, endpoint = ENDPOINT): string | null {
  if (!identity) {return null}

  try {
    const claims = JSON.parse(Buffer.from(identity.token.split('.')[1], 'base64url').toString('utf8'))

    if (typeof claims.id !== 'string' || !claims.id.trim() ||
        typeof claims.application !== 'string' || !claims.application.trim()) {return null}

    return hash(JSON.stringify([endpoint, claims.id, claims.application]))
  } catch {return null}
}

/** Product decision: legacy default-on; explicit profile opt-out always wins. */
export function telemetryEnabled(home: string): boolean {
  try {
    const file = path.join(home, 'config.yaml')
    const config = fs.existsSync(file) ? parse(fs.readFileSync(file, 'utf8')) : {}

    return !config?.plugins?.disabled?.includes('uniwork-telemetry') &&
      config?.plugins?.entries?.['uniwork-telemetry']?.settings?.enabled !== false
  } catch {return false}
}

/** A capability per local profile, never a renderer-selectable URL or credential. */
export async function startTelemetryBridge(options: TelemetryBridgeOptions) {
  const endpoint = options.endpoint ?? ENDPOINT
  const requestUpstream = options.request ?? fetch
  const bindings = new Map<string, Binding>()
  const controllers = new Set<AbortController>()
  const expectedHome = path.resolve(options.home)
  const inputs = new TelemetryInputs()

  function profileHome(home: string): string {
    const relative = path.relative(expectedHome, path.resolve(home))
    // Hermes keys plugin homes with normcase on Windows. Use the same identity for validation
    // and the input cache; a differently cased spelling of this account is still this account.
    const profilePath = process.platform === 'win32' ? relative.toLowerCase() : relative

    if (profilePath && !/^profiles[\\/][a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profilePath)) {
      throw new Error('Telemetry profile is outside the account home')
    }

    return path.resolve(expectedHome, profilePath)
  }

  function context(binding: Binding) {
    const identity = options.identity()
    const account = options.active() ? telemetryAccount(identity, endpoint) : null

    if (!identity || account !== binding.account) {return null}
    const fetched = options.plan()
    const plan = fetched.status === 'available' ? fetched.plan : null

    const models = plan?.models.map(model => ({
      modelId: model.name, modelName: model.displayName ?? model.name,
      provider: 'yuanjing', runtimeProvider: `custom:desktop-mt-maas-${hash(model.baseUrl)}`,
      baseUrl: model.baseUrl, credential: hash(plan.apiKey),
      ...(plan.productId ? { productId: plan.productId } : {}),
      ...(plan.productName ? { productName: plan.productName } : {})
    })) ?? []

    return {
      account, enabled: telemetryEnabled(binding.home), revision: hash(identity.token), models,
      client: {
        platform: options.platform === 'win32' ? 'windows' : options.platform === 'darwin' ? 'macos' : 'linux',
        appVersion: options.appVersion.slice(0, 64)
      }
    }
  }

  const server = http.createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '')

    const entry = [...bindings].find(([token]) => {
      const expected = Buffer.from(token)

      return expected.length === supplied.length && timingSafeEqual(expected, supplied)
    })

    if (!entry || request.method !== 'POST' || !['/context', '/input', '/batch'].includes(request.url ?? '')) {
      response.writeHead(404).end()

      return
    }

    try {
      const suppliedProfile = request.headers['x-uniwork-profile']

      const binding = typeof suppliedProfile === 'string'
        ? { ...entry[1], home: profileHome(Buffer.from(suppliedProfile, 'hex').toString('utf8')) }
        : entry[1]

      const chunks: Buffer[] = []
      let size = 0

      for await (const chunk of request) {
        size += chunk.length

        if (size > MAX_BYTES) {response.writeHead(413).end();

 return}

        chunks.push(chunk)
      }

      const snapshot = context(binding)

      if (!snapshot) {response.writeHead(401).end();

 return}

      if (request.url === '/context') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(snapshot))

        return
      }

      if (!snapshot.enabled) {response.writeHead(403).end();

 return}

      if (request.url === '/input') {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const sessions = [value.sessionId, value.taskId].filter((id): id is string => typeof id === 'string')
        const { recordedAt, ...input } = inputs.find(binding.home, value.requestHash, value.turnId, sessions)

        const executionId = input.submissionId ? currentExecutionId(binding.home, sessions, value.requestHash,
          { recordedAt, observedAt: value.observedAt, writerPid: value.writerPid }) : undefined

        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...input,
          ...(executionId ? { executionId } : {}) }))

        return
      }

      if (request.headers['x-uniwork-account'] !== binding.account) {response.writeHead(403).end();

 return}

      const body = Buffer.concat(chunks)
      const parsed = JSON.parse(body.toString('utf8'))

      if (!parsed || !Array.isArray(parsed.events) || parsed.events.length < 1 || parsed.events.length > 100 ||
          Object.keys(parsed).some(key => !['client', 'events'].includes(key))) {
        response.writeHead(400).end();

 return
      }

      const identity = options.identity()

      if (!options.active() || telemetryAccount(identity, endpoint) !== binding.account) {
        response.writeHead(401).end();

 return
      }

      const cancellation = new AbortController()
      controllers.add(cancellation)

      try {
        const upstream = await requestUpstream(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity!.token}` },
          // Do not serialize `parsed`: JS Number would round valid int64 token counts.
          body: new Uint8Array(body), redirect: 'error', credentials: 'omit', cache: 'no-store',
          signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(10_000)])
        })

        const result = {
          status: upstream.status, retryAfter: upstream.headers.get('Retry-After'),
          body: upstream.status === 200 ? await upstream.json() : null
        }

        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
      } finally {controllers.delete(cancellation)}
    } catch {
      response.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"telemetry_unavailable"}')
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  server.unref()
  const address = server.address()

  if (!address || typeof address === 'string') {throw new Error('Telemetry bridge failed to start')}

  return {
    rememberInput(value: TelemetryInput): void {
      if (!value || typeof value.profile !== 'string' || !options.active() || !options.identity()) {return}
      const home = profileHome(value.profile === 'default' ? expectedHome : path.join(expectedHome, 'profiles', value.profile))

      if (telemetryEnabled(home)) {inputs.remember(home, value)}
    },
    env(home: string): Record<string, string> {
      const target = profileHome(home)
      const account = options.active() ? telemetryAccount(options.identity(), endpoint) : null

      if (!account) {return {}}
      const token = randomBytes(32).toString('base64url')
      const binding = { home: target, account }
      bindings.set(token, binding)

      return {
        UNIWORK_TELEMETRY_BRIDGE: `http://127.0.0.1:${address.port}`,
        UNIWORK_TELEMETRY_TOKEN: token,
        UNIWORK_TELEMETRY_CONTEXT: JSON.stringify({ ...context(binding), home: target })
      }
    },
    async stop(): Promise<void> {
      bindings.clear()

      for (const controller of controllers) {controller.abort()}
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}
