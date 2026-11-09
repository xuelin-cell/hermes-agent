import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: {} }))

import { prepareAccountPaths } from './account-paths'
import { createAccountGatewayLogout } from './gateway-logout'
import { logoutIntentPath, recordAccountRun } from './logout'
import { recoverAccountRun } from './recover-account'

const repository = path.resolve(import.meta.dirname, '../../../..')
const python = process.env.HERMES_TEST_PYTHON ?? path.join(repository, '.venv/bin/python')

/** 只终止本测试直接创建的进程句柄，不按名称或账号枚举进行清理。 */
async function release(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  const closed = once(child, 'close')
  child.kill()
  await closed
}

/** 使用真实macOS子进程、Home及原生网关命令形式，只以轻量服务隔离模型与消息网络。 */
async function actor(moduleRoot: string, home: string) {
  const child = spawn(python, ['-m', 'hermes_cli.main', 'gateway', 'run'], {
    cwd: moduleRoot,
    env: { PATH: process.env.PATH, HOME: moduleRoot, HERMES_HOME: home, PYTHONPATH: moduleRoot },
    stdio: 'pipe'
  })

  const output = createInterface({ input: child.stdout })

  const ready = new Promise<{ pid: number; created: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture gateway did not start')), 10_000)
    output.once('line', line => {
      clearTimeout(timer)
      resolve(JSON.parse(line))
    })
    child.once('error', reject)
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('fixture gateway exited before ready'))
    })
  })

  try {
    return { child, identity: await ready }
  } catch (error) {
    await release(child)
    throw error
  } finally {
    output.close()
  }
}

it.runIf(process.platform === 'darwin').each([100, -100])(
  'macOS旧记录漂移%d厘秒仍可真实恢复，超限指纹拒绝且另一账号保持运行',
  async drift => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-fingerprint-')))
    const roots = { data: path.join(root, 'data'), userData: path.join(root, 'desktop') }
    const own = prepareAccountPaths(roots, 'fixture', 'own')
    const foreign = prepareAccountPaths(roots, 'fixture', 'foreign')
    const moduleRoot = path.join(root, 'service')
    fs.mkdirSync(path.join(moduleRoot, 'hermes_cli'), { recursive: true })
    fs.writeFileSync(path.join(moduleRoot, 'hermes_cli/__init__.py'), '')
    fs.writeFileSync(
      path.join(moduleRoot, 'hermes_cli/main.py'),
      `import json,os,pathlib,time,psutil
home=pathlib.Path(os.environ['HERMES_HOME'])
created=psutil.Process().create_time()
record={'kind':'hermes-gateway','pid':os.getpid(),'start_time':round(created*100),'hermes_home':str(home)}
(home/'gateway.pid').write_text(json.dumps(record))
print(json.dumps({'pid':os.getpid(),'created':created}),flush=True)
while True:
    marker=home/'.gateway-planned-stop.json'
    if marker.exists() and json.loads(marker.read_text()).get('target_pid')==os.getpid():
        break
    time.sleep(0.02)
`
    )
    vi.stubEnv('HOME', root)
    vi.stubEnv('HERMES_HOME', path.join(root, 'unrelated'))
    vi.stubEnv('HERMES_DISABLE_LAZY_INSTALLS', '1')
    let owned: Awaited<ReturnType<typeof actor>> | undefined
    let other: Awaited<ReturnType<typeof actor>> | undefined

    try {
      owned = await actor(moduleRoot, own.home)
      other = await actor(moduleRoot, foreign.home)
      const pidfile = path.join(own.home, 'gateway.pid')
      const record = JSON.parse(fs.readFileSync(pidfile, 'utf8'))
      const credential = path.join(roots.userData, 'maas-login.enc')
      fs.writeFileSync(credential, 'credential-sentinel')
      fs.writeFileSync(path.join(own.home, 'history-sentinel'), 'own-history')
      fs.writeFileSync(path.join(foreign.home, 'history-sentinel'), 'foreign-history')

      for (const invalid of [record.start_time + 5_000, String(record.start_time), true]) {
        fs.writeFileSync(pidfile, JSON.stringify({ ...record, start_time: invalid }))
        const context = { ...own, installationRoot: repository, python }
        const adapter = createAccountGatewayLogout(context)

        try {
          const snapshot = await adapter.run('snapshot')
          await expect(adapter.run('stop', snapshot.gateways)).rejects.toThrow('请重试')
          expect(owned.child.exitCode).toBeNull()
          expect(fs.existsSync(path.join(own.home, '.gateway-planned-stop.json'))).toBe(false)
        } finally {
          await adapter.dispose()
        }
      }

      fs.writeFileSync(pidfile, JSON.stringify({ ...record, start_time: record.start_time + drift }))
      recordAccountRun(roots.userData, own.id)
      await recoverAccountRun(roots, repository, python)
      expect(fs.existsSync(logoutIntentPath(roots.userData))).toBe(false)
      expect(fs.readFileSync(credential, 'utf8')).toBe('credential-sentinel')
      expect(fs.readFileSync(path.join(own.home, 'history-sentinel'), 'utf8')).toBe('own-history')
      expect(fs.readFileSync(path.join(foreign.home, 'history-sentinel'), 'utf8')).toBe('foreign-history')
      expect(other.child.exitCode).toBeNull()
      expect(process.kill(other.identity.pid, 0)).toBe(true)
    } finally {
      if (owned) {await release(owned.child)}

      if (other) {await release(other.child)}
      vi.unstubAllEnvs()
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
  45_000
)
