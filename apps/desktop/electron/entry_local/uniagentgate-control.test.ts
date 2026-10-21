import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'

import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), trusted: vi.fn(() => true), start: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../desktop-renderer-sender', () => ({ isDesktopRendererSender: mocks.trusted }))
vi.mock('./start-messaging-gateway', () => ({ startAccountMessagingGateway: mocks.start }))

import { LoginSession } from '../login/session'

import type { PreparedLocalContext } from './runtime-context'
import { createUniAgentGateBindingUpdate, createUniAgentGateReconnect, requestUniAgentGateReconnect } from './uniagentgate-control'
import { installUniAgentGateIpc } from './uniagentgate-ipc'

/** 本机真实 socket，账号记录与返回协议都与插件一致。 */
async function control(home: string, token: string, reply: string, requests: unknown[]) {
  const server = net.createServer(socket => {
    socket.setEncoding('utf8')
    socket.once('data', body => {
      requests.push(JSON.parse(String(body)))
      socket.end(reply + '\n')
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(path.join(home, 'uniagentgate-control.json'), JSON.stringify({
    port: (server.address() as net.AddressInfo).port, token, pid: process.pid
  }))

  return () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

it('A→B→A uses each account control credential and duplicate clicks share one request', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-rcs-control-'))
  const a: unknown[] = [], b: unknown[] = []
  const closeA = await control(path.join(root, 'A'), 'a'.repeat(64), '{"status":"connected"}', a)
  const closeB = await control(path.join(root, 'B'), 'b'.repeat(64), '{"status":"busy"}', b)

  try {
    expect(await requestUniAgentGateReconnect(path.join(root, 'A'))).toEqual({ status: 'connected' })
    expect(await requestUniAgentGateReconnect(path.join(root, 'B'))).toEqual({ status: 'busy' })
    const context = { home: path.join(root, 'A') } as PreparedLocalContext
    const reconnect = createUniAgentGateReconnect(() => context)
    const first = reconnect()
    expect(reconnect()).toBe(first)
    expect(await first).toEqual({ status: 'connected' })
    expect(a).toEqual(Array(2).fill({ token: 'a'.repeat(64), operation: 'reconnect' }))
    expect(b).toEqual([{ token: 'b'.repeat(64), operation: 'reconnect' }])
    expect(mocks.start).not.toHaveBeenCalled()
  } finally {
    await Promise.all([closeA(), closeB()])
    await fs.rm(root, { recursive: true, force: true })
  }
})

it('my-plan A→B→A writes scoped credentials then notifies that gateway; missing/invalid data preserves binding', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-rcs-live-binding-'))
  const a: unknown[] = [], b: unknown[] = []
  const closeA = await control(path.join(root, 'A'), 'a'.repeat(64), '{"status":"connected"}', a)
  const closeB = await control(path.join(root, 'B'), 'b'.repeat(64), '{"status":"unbound"}', b)
  let context: PreparedLocalContext | null = null
  const apply = createUniAgentGateBindingUpdate(() => context)

  try {
    for (const [uid, key] of [['A', 'first'], ['B', 'other'], ['A', 'rotated']]) {
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
        uid, token: `${uid}-token`, expireIn: 600
      }))

      const session = new LoginSession(request, { save: vi.fn(), load: vi.fn() }, apply)
      await session.login({ phone: '13800000000', smsCode: '123456' })
      context = { home: path.join(root, uid) } as PreparedLocalContext
      request.mockResolvedValueOnce(Response.json({ data: {
        ipUrl: 'https://gateway.invalid', agentIdPersonal: uid, agentKeyPersonal: key
      } }))
      // 模型套餐不完整不阻止独立的 5G 凭据更新。
      expect(await session.queryPlan()).toEqual({ status: 'failed' })
      const config = parse(await fs.readFile(path.join(context.home, 'config.yaml'), 'utf8'))
      expect(config.platforms.uniagentgate).toMatchObject({ agent_id: uid, enabled: true })
      const readKey = async () => parseEnv(await fs.readFile(path.join(context!.home, '.env'), 'utf8')).UNIAGENTGATE_AGENT_SK
      expect(await readKey()).toBe(key)
      const count = a.length + b.length

      for (const body of [{}, { code: 9, data: { uniagentgate: null } }, { agentKeyPersonal: '' }]) {
        request.mockResolvedValueOnce(Response.json(body))
        await session.queryPlan()
        expect(await readKey()).toBe(key)
        expect(a.length + b.length).toBe(count)
      }

      request.mockResolvedValueOnce(Response.json({ uniagentgate: null }))
      await session.queryPlan()
      expect(await readKey()).toBeFalsy()
      expect(parse(await fs.readFile(path.join(context.home, 'config.yaml'), 'utf8')).platforms.uniagentgate.enabled).toBe(false)
      session.dispose()
    }

    expect(a).toEqual(Array(4).fill({ token: 'a'.repeat(64), operation: 'apply_binding' }))
    expect(b).toEqual(Array(2).fill({ token: 'b'.repeat(64), operation: 'apply_binding' }))
  } finally {
    await Promise.all([closeA(), closeB()])
    await fs.rm(root, { recursive: true, force: true })
  }
})

it('rejects foreign scopes and does not retry a reconnect whose result is unknown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-rcs-reject-'))
  const requests: unknown[] = []
  const close = await control(root, 'c'.repeat(64), 'not-json', requests)
  const readContext = vi.fn(() => ({ home: root }) as PreparedLocalContext)

  try {
    installUniAgentGateIpc({} as never, () => 'https://renderer.invalid', readContext)
    const handler = mocks.handle.mock.calls.at(-1)![1]
    expect(await handler({}, 'worker')).toEqual({ status: 'unavailable' })
    expect(readContext).not.toHaveBeenCalled()
    mocks.trusted.mockReturnValueOnce(false)
    expect(await handler({}, 'default')).toEqual({ status: 'unavailable' })
    expect(requests).toEqual([])
    expect(await handler({}, 'default')).toEqual({ status: 'failed' })
    expect(requests).toHaveLength(1)
    expect(mocks.start).not.toHaveBeenCalled()
  } finally {
    await close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

it('requires prepared bundled plugin resources before launching a missing gateway', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-rcs-upgrade-'))
  const context = { home: root } as PreparedLocalContext
  vi.stubEnv('HERMES_BUNDLED_PLUGINS', path.join(root, 'missing-resources'))

  try {
    const plugin = path.join(root, 'plugins', 'uniagentgate')
    await fs.mkdir(plugin, { recursive: true })
    await fs.writeFile(path.join(plugin, 'plugin.yaml'), 'name: uniagentgate\nversion: 0.1.0\n')
    expect(await createUniAgentGateReconnect(() => context)()).toEqual({ status: 'restart_required' })
    expect(mocks.start).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllEnvs()
    await fs.rm(root, { recursive: true, force: true })
  }
})
