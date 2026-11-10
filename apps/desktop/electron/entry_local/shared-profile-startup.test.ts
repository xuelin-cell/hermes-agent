import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { CloudDriveMcp, type ProfileConfigApi } from '../login/cloud-drive-mcp'
import { DRIVE_MCP_MANAGED, DRIVE_MCP_SERVER } from '../login/drive-mcp-contract'

import { SharedProfileStartup } from './shared-profile-startup'

let root: string
let drive: CloudDriveMcp

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-shared-profile-'))
  drive = new CloudDriveMcp({} as never, root, path.join(root, 'workspace'))
  const plugin = path.join(root, 'app', 'assets', 'artifact-share-plugin')
  fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(path.join(plugin, 'plugin.yaml'), 'name: desktop-artifact-share\n')
  const titles = path.join(root, 'app', 'assets', 'uniwork-titles')
  fs.mkdirSync(titles, { recursive: true })
  fs.writeFileSync(path.join(titles, 'plugin.yaml'), 'name: uniwork-titles\n')

  for (const profile of ['expert-a', 'expert-b']) {
    fs.mkdirSync(path.join(root, 'profiles', profile), { recursive: true })
    fs.writeFileSync(path.join(root, 'profiles', profile, 'config.yaml'), '# API owns this file\n')
  }
})

afterEach(async () => {
  await drive.close()
  fs.rmSync(root, { recursive: true, force: true })
})

/** 给编排提供真实账号目录和云盘端点，其余结果通过测试控制。 */
function startup(overrides: Partial<ConstructorParameters<typeof SharedProfileStartup>[0]> = {}) {
  return new SharedProfileStartup({
    home: root,
    appRoot: path.join(root, 'app'),
    drive,
    interrupted: { claim: vi.fn() },
    refreshConnectors: vi.fn(async () => undefined),
    active: () => true,
    log: vi.fn(),
    ...overrides
  })
}

it('已准备助手立即复用，同步按助手节流且不等待响应；后端重启重置节流', async () => {
  let now = 0
  const profiles = startup({ now: () => now })
  profiles.reset(new Set(['default', 'expert-a', 'expert-b']))
  const api = vi.fn<ProfileConfigApi>(() => new Promise(() => undefined))
  await Promise.all(['default', 'expert-a', 'expert-a', 'expert-b'].map(name => profiles.ensure(name, api)))
  expect(api.mock.calls).toEqual(
    ['expert-a', 'expert-b'].map(profile => ['POST', '/api/plugins/uniwork-kits/expert-sync', { profile }])
  )
  now = 59_999
  await profiles.ensure('expert-a', api)
  expect(api).toHaveBeenCalledTimes(2)
  now++
  await profiles.ensure('expert-a', api)
  expect(api).toHaveBeenCalledTimes(3)
  profiles.reset(new Set(['expert-a']))
  await profiles.ensure('expert-a', api)
  expect(api).toHaveBeenCalledTimes(4)
})

it('运行中新助手合并准备，配置只走 API；补标题扩展并关原版命名，保留个人插件和关闭偏好，云盘凭据按助手区分', async () => {
  const refreshConnectors = vi.fn(async () => undefined)
  const claim = vi.fn()
  const profiles = startup({ refreshConnectors, interrupted: { claim } })

  // expert-b 已手动停用标题扩展并关过原版命名：不重新启用，也不重复保存命名开关。
  const disabledPlugins: Record<string, string[]> = {
    'expert-a': ['desktop-deliverables'],
    'expert-b': ['desktop-deliverables', 'uniwork-titles', 'uniwork-telemetry']
  }

  const saved: Record<string, any> = Object.fromEntries(
    ['expert-a', 'expert-b'].map(profile => [
      profile,
      {
        plugins: { enabled: ['personal'], disabled: disabledPlugins[profile] },
        ...(profile === 'expert-b' ? { auxiliary: { title_generation: { enabled: false } } } : {}),
        mcp_servers: {
          [DRIVE_MCP_SERVER]: {
            uniwork_managed: DRIVE_MCP_MANAGED,
            enabled: false,
            timeout: 600,
            tools: ['filesearch']
          }
        }
      }
    ])
  )

  const apis = Object.fromEntries(
    Object.keys(saved).map(profile => [
      profile,
      vi.fn<ProfileConfigApi>(async (method, route, body) => {
        if (method === 'POST') {
          return { changes: [] }
        }

        if (method === 'PUT') {
          const patch = (body as any).config

          if (patch.plugins) {
            Object.assign(saved[profile].plugins, patch.plugins)
          }

          if (patch.auxiliary) {
            saved[profile].auxiliary = patch.auxiliary
          }

          if (patch.mcp_servers) {
            Object.assign(saved[profile].mcp_servers[DRIVE_MCP_SERVER], patch.mcp_servers[DRIVE_MCP_SERVER])
          }
        }

        return structuredClone(saved[profile])
      })
    ])
  )

  await Promise.all(['expert-a', 'expert-b', 'expert-a'].map(profile => profiles.ensure(profile, apis[profile])))
  expect(refreshConnectors.mock.calls).toEqual([['expert-a'], ['expert-b']])
  expect(claim).toHaveBeenCalledTimes(2)
  const tokens: string[] = []

  for (const profile of ['expert-a', 'expert-b']) {
    expect(saved[profile].plugins).toEqual({
      enabled: ['personal', 'desktop-artifact-share', ...(profile === 'expert-a' ? ['uniwork-titles', 'uniwork-telemetry'] : [])],
      disabled: disabledPlugins[profile]
    })
    expect(saved[profile].auxiliary).toEqual({ title_generation: { enabled: false } })
    expect(
      apis[profile].mock.calls.filter(([method, , body]) => method === 'PUT' && (body as any).config.auxiliary)
    ).toHaveLength(profile === 'expert-a' ? 1 : 0)
    const titleHome = path.join(root, 'profiles', profile)
    expect(fs.existsSync(path.join(titleHome, 'plugins', 'uniwork-titles', 'plugin.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(titleHome, 'plugin-data', 'uniwork-titles', 'enabled-at'))).toBe(true)
    const entry = saved[profile].mcp_servers[DRIVE_MCP_SERVER]
    expect(entry).toMatchObject({ enabled: false, timeout: 720, tools: ['filesearch'] })
    tokens.push(entry.headers.Authorization)
    expect(fs.readFileSync(path.join(root, 'profiles', profile, 'config.yaml'), 'utf8')).toBe('# API owns this file\n')
    expect(
      fs.existsSync(path.join(root, 'profiles', profile, 'plugins', 'desktop-artifact-share', 'plugin.yaml'))
    ).toBe(true)

    const response = await fetch(entry.url, {
      method: 'POST',
      headers: { Authorization: entry.headers.Authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })

    expect(response.status).toBe(200)
    expect((await response.json()).result.tools).toEqual([])
    expect((await fetch(entry.url, { method: 'POST' })).status).toBe(403)
  }

  expect(tokens[0]).not.toBe(tokens[1])
  await profiles.ensure('expert-a', apis['expert-a'])
  expect(claim).toHaveBeenCalledTimes(2)
})

it('准备失败只记日志并放行请求，下次重试；退出、删档与后端重启使迟到响应失效且不会重新复制插件', async () => {
  let active = true
  const refreshConnectors = vi.fn(async () => undefined)
  const log = vi.fn()
  const profiles = startup({ active: () => active, refreshConnectors, log })

  const failed = vi.fn<ProfileConfigApi>(async () => {
    throw new Error('unavailable')
  })

  await expect(profiles.ensure('expert-a', failed)).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledWith(expect.stringContaining('preparation failed profile=expert-a'))
  await expect(profiles.ensure('expert-a', failed)).resolves.toBeUndefined()
  expect(failed.mock.calls.filter(([method]) => method === 'GET')).toHaveLength(2)

  for (const reason of ['reset', 'forget', 'exit']) {
    let release!: (value: unknown) => void

    const api = vi.fn<ProfileConfigApi>(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )

    const work = profiles.ensure('expert-a', api)
    const check = expect(work).rejects.toThrow('superseded')
    await Promise.resolve()

    if (reason === 'reset') {
      profiles.reset()
    }

    if (reason === 'forget') {
      profiles.forget('expert-a')
    }

    if (reason === 'exit') {
      active = false
    }

    release({})
    await check
    expect(api).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(path.join(root, 'profiles', 'expert-a', 'plugins'))).toBe(false)
  }

  expect(refreshConnectors).not.toHaveBeenCalled()
  active = true
  const api = vi.fn<ProfileConfigApi>(async () => ({}))
  await profiles.ensure('expert-a', api)
  expect(refreshConnectors).toHaveBeenCalledExactlyOnceWith('expert-a')
  await expect(profiles.ensure('../other-account', api)).rejects.toThrow('No such local profile')
})
