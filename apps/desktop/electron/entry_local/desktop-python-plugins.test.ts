import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { accountDesktopEnvironment, accountSourceBackend } from './desktop-environment'
import { desktopPythonPluginsRoot, retireAccountUniAgentGatePlugin } from './desktop-python-plugins'
import type { PreparedLocalContext } from './runtime-context'

const desktop = path.resolve(import.meta.dirname, '../..')
const source = path.resolve(desktop, '../..')

function stage(out: string) {
  execFileSync(process.execPath, [path.join(desktop, 'scripts/stage-python-plugins.mjs'), '--source', source, '--out', out])

  return path.join(out, 'python-plugins')
}

it('构建合并官方与 5G 插件，开发/安装版直接发现同一资源目录，账号不创建插件入口', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bundled-plugins-'))

  try {
    const app = path.join(root, 'app')
    const shared = stage(path.join(app, 'dist'))
    // 重建不残留已从源码移除的插件。
    fs.mkdirSync(path.join(shared, 'obsolete-fixture'))
    stage(path.join(app, 'dist'))
    expect(fs.existsSync(path.join(shared, 'obsolete-fixture'))).toBe(false)

    for (const name of fs.readdirSync(path.join(source, 'plugins'))) {
      if (name !== '__pycache__' && !name.endsWith('.pyc')) {
        expect(fs.existsSync(path.join(shared, name))).toBe(true)
      }
    }

    expect(fs.existsSync(path.join(shared, 'uniagentgate', 'control.py'))).toBe(true)
    expect(desktopPythonPluginsRoot(app)).toBe(fs.realpathSync(shared))
    const builder = createRequire(import.meta.url)(path.join(desktop, 'electron-builder.config.cjs'))
    const resource = builder.extraResources.find((item: { from: string }) => item.from === 'dist/python-plugins')
    expect(resource).toBeTruthy()
    expect(builder.files).toContain('!dist/python-plugins/**')
    expect(builder.files).toContain('!assets/uniagentgate-plugin/**')
    const resources = path.join(root, 'resources')
    fs.cpSync(path.join(app, resource.from), path.join(resources, resource.to), { recursive: true })
    const installed = desktopPythonPluginsRoot(path.join(root, 'app.asar'), resources)
    expect(installed).toBe(fs.realpathSync(path.join(resources, resource.to)))

    for (const name of ['A', 'B', 'A']) {
      const home = path.join(root, name)
      fs.mkdirSync(home, { recursive: true })
      retireAccountUniAgentGatePlugin(home, installed)
      const context = { home, workspace: home, installationRoot: source, python: 'fixture-python' } as PreparedLocalContext
      const env = accountDesktopEnvironment(context, { HERMES_BUNDLED_PLUGINS: installed })
      const backend = accountSourceBackend(context, ['gateway', 'run'], env)
      const childEnv = { ...env, ...backend.env }
      expect(childEnv.HERMES_BUNDLED_PLUGINS).toBe(installed)
      expect(childEnv.HERMES_HOME).toBe(home)
      expect(fs.existsSync(path.join(home, 'plugins'))).toBe(false)
      expect(fs.existsSync(path.join(home, 'plugin-backups'))).toBe(false)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

it('旧副本/目录链接移出发现目录，保留用户数据与共享目标；迁移失败保持原入口', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-retire-plugin-'))

  try {
    const shared = stage(path.join(root, 'dist'))
    const home = path.join(root, 'account')
    const old = path.join(home, 'plugins/uniagentgate')
    fs.mkdirSync(old, { recursive: true })
    fs.writeFileSync(path.join(old, 'keep.txt'), 'legacy-user-file')
    fs.writeFileSync(path.join(home, 'config.yaml'), 'unchanged-config')
    fs.writeFileSync(path.join(home, '.env'), 'UNCHANGED=fixture-secret')
    fs.mkdirSync(path.join(home, 'plugins/other'))
    const fail = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('fixture move failure') })

    try {
      expect(() => retireAccountUniAgentGatePlugin(home, shared)).toThrow('fixture move failure')
      expect(fs.readFileSync(path.join(old, 'keep.txt'), 'utf8')).toBe('legacy-user-file')
    } finally {
      fail.mockRestore()
    }

    retireAccountUniAgentGatePlugin(home, shared)
    expect(fs.existsSync(old)).toBe(false)
    const backups = path.join(home, 'plugin-backups')
    const saved = fs.readdirSync(backups).find(name => fs.existsSync(path.join(backups, name, 'plugin/keep.txt')))!
    expect(fs.readFileSync(path.join(backups, saved, 'plugin/keep.txt'), 'utf8')).toBe('legacy-user-file')
    const count = fs.readdirSync(backups).length
    retireAccountUniAgentGatePlugin(home, shared)
    expect(fs.readdirSync(backups)).toHaveLength(count)
    fs.symlinkSync(path.join(shared, 'uniagentgate'), old, process.platform === 'win32' ? 'junction' : 'dir')
    retireAccountUniAgentGatePlugin(home, shared)
    expect(fs.lstatSync(old, { throwIfNoEntry: false })).toBeUndefined()
    expect(fs.existsSync(path.join(shared, 'uniagentgate/control.py'))).toBe(true)
    expect(fs.existsSync(path.join(home, 'plugins/other'))).toBe(true)
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toBe('unchanged-config')
    expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toBe('UNCHANGED=fixture-secret')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
