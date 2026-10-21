import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'

import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { LoginSession } from '../login/session'

import { prepareLocalEnvironment } from './prepare-account'

const input = { phone: '13800000000', smsCode: '123456' }

const binding = (secret: string) => ({
  ipUrl: 'https://gateway.invalid/uag/',
  agentIdPersonal: 'personal-agent',
  agentKeyPersonal: secret,
  agentIdCloud: 'cloud-agent',
  agentKeyCloud: 'never-use-cloud-key'
})

it('真实登录到账号准备 A→B→A：个人凭据自动绑定并轮换，页面不获 secret，模型失败不丢绑定', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-5g-binding-'))
  const roots = { data: path.join(root, 'data'), userData: path.join(root, 'desktop') }
  const homes = new Map<string, string>()

  try {
    for (const [uid, secret] of [
      ['A', 'a-key'],
      ['B', 'b-key'],
      ['A', 'rotated-a-key']
    ]) {
      const save = vi.fn()

      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ code: 0, data: { uid, token: `${uid}-login-token`, expireIn: 600, plan: binding(secret) } })
        )

      const session = new LoginSession(request, { save, load: vi.fn() })
      const result = await session.login(input)
      expect(result.ok).toBe(true)
      expect(JSON.stringify([result, save.mock.calls])).not.toContain(secret)
      request.mockRejectedValueOnce(new Error('offline'))
      expect(await session.queryPlan()).toEqual({ status: 'failed' })
      const account = prepareLocalEnvironment(session, roots)
      const file = path.join(account.home, 'config.yaml')

      if (homes.has(uid)) {
        expect(account.home).toBe(homes.get(uid))
      }

      homes.set(uid, account.home)
      const config = parse(fs.readFileSync(file, 'utf8'))
      expect(config.platforms.uniagentgate).toMatchObject({
        enabled: true,
        agent_id: 'personal-agent',
        gateway_url: 'https://gateway.invalid/uag',
        typing_indicator: false
      })
      expect(config.platforms.uniagentgate.allow_from).toBeUndefined()
      expect(config.display.platforms.uniagentgate.streaming).toBe(false)
      expect(config.plugins.enabled).toContain('uniagentgate')
      expect(fs.readFileSync(file, 'utf8')).not.toContain(secret)
      expect(parseEnv(fs.readFileSync(path.join(account.home, '.env'), 'utf8')).UNIAGENTGATE_AGENT_SK).toBe(secret)
      expect(fs.existsSync(path.join(account.home, 'plugins/uniagentgate'))).toBe(false)
      const snapshot = session.currentUniAgentGate()

      if (snapshot.status === 'available') {
        snapshot.binding.agentSk = 'forged'
      }

      prepareLocalEnvironment(session, roots)
      expect(parseEnv(fs.readFileSync(path.join(account.home, '.env'), 'utf8')).UNIAGENTGATE_AGENT_SK).toBe(secret)
      session.dispose()
    }

    expect(homes.get('A')).not.toBe(homes.get('B'))
    expect(parseEnv(fs.readFileSync(path.join(homes.get('B')!, '.env'), 'utf8')).UNIAGENTGATE_AGENT_SK).toBe('b-key')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('套餐缺失/错误字段保留绑定，显式 null 停用且清 SK，无套餐不等于撤销，恢复不借其他账号', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-5g-clear-'))
  const roots = { data: path.join(root, 'data'), userData: path.join(root, 'desktop') }

  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
    Response.json({
      uid: 'A',
      token: 'login-key',
      expireIn: 600,
      plan: binding('original-agent-key')
    })
  )

  const session = new LoginSession(request, { save: vi.fn(), load: vi.fn() })

  try {
    await session.login(input)
    const account = prepareLocalEnvironment(session, roots)
    const file = path.join(account.home, 'config.yaml')
    const envFile = path.join(account.home, '.env')
    fs.appendFileSync(envFile, 'PERSONAL_KEY="keep-me"\n')

    for (const body of [
      { apiKey: null, models: null },
      { ipUrl: 'https://gateway.invalid', agentKeyPersonal: '' },
      { code: 9, uniagentgate: null }
    ]) {
      request.mockResolvedValueOnce(Response.json(body))
      const display = await session.queryPlan()
      expect(JSON.stringify(display)).not.toContain('original-agent-key')
      prepareLocalEnvironment(session, roots)
      expect(parse(fs.readFileSync(file, 'utf8')).platforms.uniagentgate.enabled).toBe(true)
      expect(parseEnv(fs.readFileSync(envFile, 'utf8')).UNIAGENTGATE_AGENT_SK).toBe('original-agent-key')
    }

    // 5G 撤销独立于模型目录是否完整。
    request.mockResolvedValueOnce(Response.json({ uniagentgate: null }))
    expect(await session.queryPlan()).toEqual({ status: 'failed' })
    prepareLocalEnvironment(session, roots)
    expect(parse(fs.readFileSync(file, 'utf8')).platforms.uniagentgate).toEqual({
      enabled: false,
      gateway_restart_notification: false,
      typing_indicator: false
    })
    expect(parseEnv(fs.readFileSync(envFile, 'utf8'))).toMatchObject({
      PERSONAL_KEY: 'keep-me',
      UNIAGENTGATE_AGENT_SK: ''
    })
    session.dispose()
    expect(session.currentUniAgentGate()).toEqual({ status: 'missing' })
  } finally {
    session.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
