import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { migrateTerminalCwd, prepareWorkRoot, usableWorkRoot, WORK_ROOT_FILE } from './work-root'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-root-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

it('自选位置直接作为工作根，不加账号目录，也不留下检查用的文件夹', () => {
  const workspace = path.join(home, '123456789abc', 'workspace')
  const chosen = path.join(home, 'chosen')
  fs.mkdirSync(chosen)
  const options = { workspace, home, defaultDir: chosen, blocked: () => false, log: vi.fn() }
  expect(prepareWorkRoot({ ...options, defaultDir: null })).toEqual({ root: workspace, unusableDir: null })
  expect(prepareWorkRoot(options)).toEqual({ root: fs.realpathSync(chosen), unusableDir: null })
  expect(fs.readdirSync(chosen)).toEqual([])
})

it('目录联接解析成实际路径，对话文件夹才能建在里面', () => {
  const target = path.join(home, 'target')
  const link = path.join(home, 'link')
  fs.mkdirSync(target)
  fs.symlinkSync(target, link, 'junction')
  expect(usableWorkRoot(link, () => false)).toBe(fs.realpathSync(target))
  expect(fs.lstatSync(usableWorkRoot(link, () => false)).isDirectory()).toBe(true)
})

it('默认位置不可用时退回 workspace，并记下不可用的位置', () => {
  const workspace = path.join(home, '123456789abc', 'workspace')
  const options = { workspace, home, defaultDir: home, blocked: () => false, log: vi.fn() }

  for (const overrides of [
    { blocked: () => true },
    { defaultDir: path.join(home, WORK_ROOT_FILE) },
    { defaultDir: path.join(home, 'missing') }
  ]) {
    fs.writeFileSync(path.join(home, WORK_ROOT_FILE), '')
    const unusableDir = overrides.defaultDir ?? home
    expect(prepareWorkRoot({ ...options, ...overrides })).toEqual({ root: workspace, unusableDir })
    expect(JSON.parse(fs.readFileSync(path.join(home, WORK_ROOT_FILE), 'utf8'))).toEqual({
      root: workspace,
      fallback: workspace
    })
  }
})

it.each([
  '',
  '[bad',
  'terminal: &t {cwd: /shared}',
  'terminal: {cwd: &shared /shared}\nother: *shared',
  'terminal: {<<: {cwd: /shared}}',
  'terminal: {}',
  ...['auto', 'cwd', '.', ''].map(cwd => 'terminal: {cwd: "' + cwd + '"}')
])('保留共享、特殊或无效 YAML：%s', yaml => {
  const file = path.join(home, 'config.yaml')

  if (yaml) {fs.writeFileSync(file, yaml)}
  migrateTerminalCwd(home, path.join(home, 'project-dir.json'), vi.fn())
  expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').toBe(yaml)
})

it.each(['first', 'existing', 'relative', 'missing'])('仅清理主账号旧键：%s', kind => {
  const file = path.join(home, 'config.yaml')
  const pref = path.join(home, 'project-dir.json')
  const cwd = kind === 'relative' ? 'relative' : kind === 'missing' ? path.join(home, 'missing') : home
  const original = '# keep\nterminal:\n  cwd: ' + JSON.stringify(cwd) + '\n  timeout: 42\n'
  fs.writeFileSync(file, original)
  const profile = path.join(home, 'profiles', 'expert')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'config.yaml'), original)

  if (kind === 'existing') {fs.writeFileSync(pref, JSON.stringify({ dir: 'previous' }))}
  migrateTerminalCwd(home, pref, vi.fn())
  const next = fs.readFileSync(file, 'utf8')
  expect(next).toContain('# keep')
  expect(next).toContain('timeout: 42')
  expect(next).not.toContain('cwd:')
  expect(fs.readFileSync(path.join(profile, 'config.yaml'), 'utf8')).toBe(original)
  expect(fs.existsSync(pref) ? JSON.parse(fs.readFileSync(pref, 'utf8')).dir : null).toBe(
    kind === 'first' ? home : kind === 'existing' ? 'previous' : null
  )
})
