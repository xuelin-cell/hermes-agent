import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { prepareAccountPaths } from './account-paths'
import { prepareAccountDependencyStorage } from './dependency-storage'

const temporary: string[] = []

/** 使用独立真实目录验证联接，不接触已登录账号。 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd-'))
  temporary.push(root)
  const roots = { data: root, userData: path.join(root, 'desktop') }
  const a = prepareAccountPaths(roots, 'platform', 'A')
  const b = prepareAccountPaths(roots, 'platform', 'B')

  return { root, roots, a, b }
}

afterEach(() => {
  for (const root of temporary.splice(0)) {fs.rmSync(root, { recursive: true, force: true })}
})

it.skipIf(process.platform !== 'win32')('缩短真实依赖路径，A→B→A 保留独立内容且不移动账号数据', () => {
  const { roots, a, b } = fixture()
  const installs = path.join(a.home, 'installs')
  fs.mkdirSync(installs)
  fs.writeFileSync(path.join(installs, 'dependency'), 'A')
  fs.writeFileSync(path.join(a.home, 'state.db'), 'history')
  const source = path.resolve(import.meta.dirname, '../../../..')
  const key = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const install = path.join(installs, key)
  const environment = path.join(install, 'environments', 'b'.repeat(32), 'venv')
  const site = path.join(environment, 'Lib', 'site-packages')
  fs.mkdirSync(site, { recursive: true })
  fs.copyFileSync(path.join(source, '.venv', 'pyvenv.cfg'), path.join(environment, 'pyvenv.cfg'))
  fs.cpSync(path.join(source, '.venv', 'Lib', 'site-packages', 'psutil'), path.join(site, 'psutil'), { recursive: true })
  // 使用原版 PM 的真实选择路径，验证旧记录经联接解析后能加载原生扩展。
  fs.writeFileSync(path.join(install, 'facts.json'), JSON.stringify({ packages: { venv: { environment } } }))
  prepareAccountDependencyStorage(roots, a)
  prepareAccountDependencyStorage(roots, b)
  expect(fs.realpathSync(installs).length).toBeLessThan(installs.length)
  expect(fs.readFileSync(path.join(installs, 'dependency'), 'utf8')).toBe('A')
  expect(fs.readdirSync(path.join(b.home, 'installs'))).toEqual([])
  prepareAccountDependencyStorage(roots, a)
  expect(fs.readFileSync(path.join(a.home, 'state.db'), 'utf8')).toBe('history')

  const output = execFileSync(path.join(source, '.venv', 'Scripts', 'python.exe'), ['-c',
    'import os,json; from pathlib import Path; from pm.environments import activate_dependencies; activate_dependencies(Path.cwd()); import psutil; print(json.dumps({"created":psutil.Process().create_time(),"native":psutil._psplatform.cext.__file__}))'], {
    cwd: source, env: { ...process.env, HERMES_HOME: a.home, PYTHONPATH: source, PYTHONDONTWRITEBYTECODE: '1' },
    windowsHide: true, encoding: 'utf8', timeout: 20_000
  })

  const loaded = JSON.parse(output)
  expect(loaded.created).toBeGreaterThan(0)
  expect(loaded.native.startsWith(fs.realpathSync(installs))).toBe(true)
  // 模拟重命名完成、尚未创建联接时退出；重新准备复用原依赖。
  fs.unlinkSync(installs)
  prepareAccountDependencyStorage(roots, a)
  expect(fs.readFileSync(path.join(installs, 'dependency'), 'utf8')).toBe('A')
})

it.skipIf(process.platform !== 'win32')('拒绝外部联接、目标劫持和双目录冲突，保留原内容', () => {
  const { root, roots, a } = fixture()
  const outside = path.join(root, 'outside')
  const installs = path.join(a.home, 'installs')
  const target = path.join(roots.data, 'deps', a.id.slice('account-'.length))
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, installs, 'junction')
  expect(() => prepareAccountDependencyStorage(roots, a)).toThrow('目标不符')
  fs.unlinkSync(installs)
  fs.mkdirSync(path.dirname(target))
  fs.symlinkSync(outside, target, 'junction')
  expect(() => prepareAccountDependencyStorage(roots, a)).toThrow('真实目录')
  fs.unlinkSync(target)
  fs.mkdirSync(target)
  fs.mkdirSync(installs)
  fs.writeFileSync(path.join(installs, 'keep'), 'original')
  expect(() => prepareAccountDependencyStorage(roots, a)).toThrow('冲突')
  expect(fs.readFileSync(path.join(installs, 'keep'), 'utf8')).toBe('original')
  expect(fs.readdirSync(outside)).toEqual([])
})
