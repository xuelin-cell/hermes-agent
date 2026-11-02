import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { afterEach, expect, it, vi } from 'vitest'

// Only Electron credential storage is absent in the Node test host. Recovery,
// process inspection, the Python adapter and account files are all real.
vi.mock('electron', () => ({ safeStorage: {} }))

import { prepareAccountPaths } from './account-paths'
import { createAccountGatewayLogout } from './gateway-logout'
import { logoutIntentPath, recordAccountRun } from './logout'
import { recoverAccountRun } from './recover-account'

const repository = path.resolve(import.meta.dirname, '../../../..')
const python = process.env.HERMES_TEST_PYTHON ?? path.join(repository, '.venv/bin/python')
const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()

  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** 父夹具故意延迟waitpid，生成真实已退出但PID尚未回收的macOS子进程。 */
async function zombie(home: string, root: string) {
  const script = `
import json, os, pathlib, psutil, sys, time
pid = os.fork()
if pid == 0:
    os._exit(0)
try:
    deadline = time.monotonic() + 5
    while psutil.Process(pid).status() != psutil.STATUS_ZOMBIE:
        if time.monotonic() >= deadline:
            raise RuntimeError('zombie fixture timeout')
        time.sleep(0.01)
    created = psutil.Process(pid).create_time()
    record = {'kind':'hermes-gateway','pid':pid,'start_time':round(created*100),'hermes_home':sys.argv[1]}
    pathlib.Path(sys.argv[1], 'gateway.pid').write_text(json.dumps(record))
    print(json.dumps({'pid':pid,'created':created,'parent':os.getpid()}), flush=True)
    sys.stdin.readline()
finally:
    os.waitpid(pid, 0)
`

  const child = spawn(python, ['-c', script, home], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, HERMES_HOME: home },
    stdio: 'pipe'
  })

  const output = createInterface({ input: child.stdout })

  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('zombie fixture did not become ready'))
    }, 10_000)

    output.once('line', line => {
      clearTimeout(timer)
      resolve(line)
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)

      if (code) {
        reject(new Error('zombie fixture exited'))
      }
    })
  })

  const identity = JSON.parse(await ready) as { pid: number; created: number; parent: number }

  return { child, output, identity }
}

/** 回收本测试自己的父子进程，不按名称清理系统或用户进程。 */
async function reap(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close')
    child.stdin.end('\n')
    await closed
  }
}

/** 每例只使用独立账号目录与明确解释器。 */
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-zombie-')))
  roots.push(root)
  vi.stubEnv('HOME', root)
  vi.stubEnv('HERMES_HOME', path.join(root, 'unused'))
  vi.stubEnv('HERMES_DISABLE_LAZY_INSTALLS', '1')
  const accountRoots = { data: path.join(root, 'data'), userData: path.join(root, 'desktop') }
  const account = prepareAccountPaths(accountRoots, 'test-platform', 'a')
  const foreign = prepareAccountPaths(accountRoots, 'test-platform', 'b')

  return { root, accountRoots, account, foreign, context: { ...account, installationRoot: repository, python } }
}

it.runIf(process.platform === 'darwin')(
  '真实僵尸网关：快照、停止和终检通过，PID记录不靠删除放行',
  async () => {
    const f = fixture()
    const held = await zombie(f.account.home, f.root)
    const pidfile = path.join(f.account.home, 'gateway.pid')
    const before = fs.readFileSync(pidfile)
    const gateway = createAccountGatewayLogout(f.context)

    try {
      const snapshot = await gateway.run('snapshot')
      expect(snapshot.processes.some(row => row.pid === held.identity.pid)).toBe(true)
      expect(snapshot.gateways).toEqual([])
      expect(await gateway.run('stop', snapshot.gateways)).toEqual({ processes: [], gateways: [] })
      expect(await gateway.run('check')).toEqual({ processes: [], gateways: [] })
      expect(fs.readFileSync(pidfile)).toEqual(before)
      expect(held.child.exitCode).toBeNull()
    } finally {
      await gateway.dispose()
      held.output.close()
      await reap(held.child)
    }
  },
  30_000
)

it.runIf(process.platform === 'darwin')(
  '真实退出恢复：僵尸遗留不挡重开，登录记录、双方历史与另一账号保留',
  async () => {
    const f = fixture()
    const held = await zombie(f.account.home, f.root)
    const credential = path.join(f.accountRoots.userData, 'maas-login.enc')
    const history = path.join(f.account.home, 'state.db')
    const foreignHistory = path.join(f.foreign.home, 'state.db')
    fs.writeFileSync(credential, 'credential-sentinel')
    fs.writeFileSync(history, 'history-a')
    fs.writeFileSync(foreignHistory, 'history-b')
    recordAccountRun(f.accountRoots.userData, f.account.id)
    fs.writeFileSync(
      logoutIntentPath(f.accountRoots.userData),
      JSON.stringify({
        account: f.account.id,
        mode: 'quit',
        processes: [
          { pid: held.identity.pid, parent: held.identity.parent, started: String(Math.floor(held.identity.created)) }
        ]
      })
    )

    try {
      await recoverAccountRun(f.accountRoots, repository, python)
      expect(fs.existsSync(logoutIntentPath(f.accountRoots.userData))).toBe(false)
      expect(fs.readFileSync(credential, 'utf8')).toBe('credential-sentinel')
      expect(fs.readFileSync(history, 'utf8')).toBe('history-a')
      expect(fs.readFileSync(foreignHistory, 'utf8')).toBe('history-b')
      expect(held.child.exitCode).toBeNull()
    } finally {
      held.output.close()
      await reap(held.child)
    }
  },
  30_000
)

it.runIf(process.platform === 'darwin')(
  '存活但命令不可读的记录仍拒绝放行',
  async () => {
    const f = fixture()
    const script = path.join(f.root, 'unreadable-snapshot.py')
    fs.writeFileSync(
      path.join(f.account.home, 'gateway.pid'),
      JSON.stringify({ pid: process.pid, hermes_home: f.account.home })
    )
    // Only emulate an unavailable command line; Process.status() still probes the real live Node PID.
    fs.writeFileSync(
      script,
      `import runpy\nns=runpy.run_path(${JSON.stringify(path.join(repository, 'apps/desktop/electron/entry_local/gateway-logout.py'))})\ng=ns['main'].__globals__\ng['process_snapshot']=lambda:[{'pid':${process.pid},'parent':1,'started':'1','command':''}]\nns['main']()\n`
    )
    const gateway = createAccountGatewayLogout({ ...f.context, gatewayLogoutScript: script })

    try {
      await expect(gateway.run('snapshot')).rejects.toThrow('请重试')
    } finally {
      await gateway.dispose()
    }
  },
  30_000
)
