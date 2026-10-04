import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { MAAS_IDENTITY_NAMESPACE } from '../login/credential-store'
import { LoginSession } from '../login/session'
import { createSourcePythonBackend } from '../source-backend'

import { LocalRuntimeContext } from './runtime-context'

/** 创建独立的源码安装与账号根目录，不运行替身解释器。 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-runtime-context-'))
  const source = path.join(root, 'source')
  const python = path.join(source, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  fs.mkdirSync(path.dirname(python), { recursive: true })
  fs.mkdirSync(path.join(source, 'hermes_cli'))
  fs.writeFileSync(python, '')
  fs.writeFileSync(path.join(source, 'hermes_cli/main.py'), '')

  return { root, source, python, roots: { data: path.join(root, 'data'), userData: path.join(root, 'desktop') } }
}

it('可信身份固定 A/B 数据路径，安装与 Python 不变；重复准备和 A→B→A 复用，退出保留文件', async () => {
  const f = fixture()
  const inheritedHome = process.env.HERMES_HOME
  let firstA

  try {
    for (const uid of ['account-A', 'account-B', 'account-A']) {
      const session = new LoginSession(vi.fn(), {
        save: vi.fn(),
        load: () => ({
          namespace: MAAS_IDENTITY_NAMESPACE,
          uid,
          token: 'private-token',
          maskedPhone: '138****0000',
          expiresAt: Date.now() + 60_000
        })
      })

      const runtime = new LocalRuntimeContext(session, f.roots, f.source)
      expect(() => runtime.prepare()).toThrow('请先登录')
      expect(runtime.current()).toBeNull()
      session.restore()
      const context = runtime.prepare()
      expect(runtime.current()).toBe(context)
      expect(runtime.prepare()).toBe(context)
      expect(Object.isFrozen(context)).toBe(true)
      expect(context.installationRoot).toBe(f.source)
      expect(context.python).toBe(f.python)

      const backend = createSourcePythonBackend(context.installationRoot, context.python, ['serve'], {
        env: { HERMES_HOME: context.home }
      })

      expect(backend?.root).toBe(f.source)
      expect(backend?.command).toBe(f.python)
      expect(backend?.env.PYTHONPATH).toBe(f.source)
      const marker = path.join(context.workspace, 'marker')

      if (uid === 'account-A' && firstA) {
        expect(context).toEqual(firstA)
        expect(fs.readFileSync(marker, 'utf8')).toBe('keep-A')
      } else {
        expect(fs.existsSync(marker)).toBe(false)
        fs.writeFileSync(marker, uid === 'account-A' ? 'keep-A' : 'keep-B')
      }

      if (!firstA) {
        firstA = context
      } else if (uid === 'account-B') {
        expect(context.id).not.toBe(firstA.id)
      }

      const response = JSON.stringify(context)
      expect(response).not.toContain('private-token')
      expect(response).not.toContain(uid)
      runtime.dispose()
      expect(session.currentIdentity()).toBeNull()
      expect(runtime.current()).toBeNull()
      expect(fs.existsSync(marker)).toBe(true)
    }

    expect(process.env.HERMES_HOME).toBe(inheritedHome)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

it('套餐鉴权拒绝仍可准备本地环境，将无凭据的失败提示交接到桌面', async () => {
  const f = fixture()

  const login = new LoginSession(vi.fn().mockResolvedValue(new Response('', { status: 401 })), {
    save: vi.fn(),
    load: () => ({
      namespace: MAAS_IDENTITY_NAMESPACE,
      uid: 'account-A',
      token: 'private-token',
      maskedPhone: '138****0000',
      expiresAt: Date.now() + 60_000
    })
  })

  const runtime = new LocalRuntimeContext(login, f.roots, f.source)

  try {
    login.restore()
    await login.queryPlan()
    const context = runtime.prepare()
    expect(runtime.current()).toBe(context)
    expect(runtime.currentAccount()).toMatchObject({ maskedPhone: '138****0000', planAuthRejected: true })
    expect(JSON.stringify(runtime.currentAccount())).not.toContain('private-token')
    runtime.dispose()
    expect(runtime.currentAccount()).toBeNull()
  } finally {
    runtime.dispose()
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

it('准备失败可重试，已准备环境跨到期保留；到期不能重新准备或同进程换账号', async () => {
  const f = fixture()
  let uid = 'account-A'
  const expiresAt = Date.now() + 60_000
  const request = vi.fn<typeof fetch>()

  const session = new LoginSession(request, {
    save: vi.fn(),
    load: () => ({
      namespace: MAAS_IDENTITY_NAMESPACE,
      uid,
      token: 'private-token',
      maskedPhone: '138****0000',
      expiresAt
    })
  })

  const runtime = new LocalRuntimeContext(session, f.roots, f.source)

  try {
    session.restore()
    fs.unlinkSync(f.python)
    expect(() => runtime.prepare()).toThrow('开发仓库的 Python')
    expect(fs.existsSync(f.roots.data)).toBe(false)
    fs.writeFileSync(f.python, '')
    const context = runtime.prepare()
    const file = path.join(context.home, '.env')
    fs.writeFileSync(file, 'PERSONAL_KEY=keep\n')
    fs.mkdirSync(`${file}.tmp`)
    request.mockResolvedValueOnce(Response.json({ apiKey: null, models: null }))
    await session.queryPlan()
    expect(() => runtime.prepare()).toThrow('本次环境准备未完成')
    expect(runtime.current()).toBeNull()
    expect(fs.readFileSync(file, 'utf8')).toBe('PERSONAL_KEY=keep\n')
    fs.rmdirSync(`${file}.tmp`)
    expect(runtime.prepare()).toBe(context)
    vi.spyOn(Date, 'now').mockReturnValue(expiresAt)
    expect(runtime.current()).toBe(context)
    expect(runtime.currentAccount()).toEqual({ maskedPhone: '138****0000', expiresAt })
    expect(session.currentIdentity()).toBeNull()
    expect(runtime.current()).toBe(context)
    expect(runtime.currentAccount()).toEqual({ maskedPhone: '138****0000', expiresAt })
    expect(() => runtime.prepare()).toThrow('请先登录')
    vi.restoreAllMocks()
    uid = 'account-B'
    session.restore()
    expect(() => runtime.prepare()).toThrow('不能更换账号')
    expect(runtime.current()).toBeNull()
    expect(fs.readdirSync(path.join(f.roots.data, 'accounts'))).toEqual([context.id])
  } finally {
    runtime.dispose()
    vi.restoreAllMocks()
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
