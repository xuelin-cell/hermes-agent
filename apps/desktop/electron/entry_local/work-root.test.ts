import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { migrateTerminalCwd, prepareWorkRoot, WORK_ROOT_FILE, workRootFor } from './work-root'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-root-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

it('自选位置含账号短目录，默认值和回退指向 workspace', () => {
  const workspace = path.join(home, '123456789abc', 'workspace')
  const options = { workspace, home, defaultDir: home, blocked: () => false, log: vi.fn() }
  expect(workRootFor(null, workspace)).toBe(workspace)
  expect(prepareWorkRoot(options)).toBe(path.dirname(workspace))
  if (process.platform === 'win32') expect(workRootFor('D:\\', workspace)).toBe('D:\\123456789abc')
  for (const overrides of [{ blocked: () => true }, { defaultDir: path.join(home, WORK_ROOT_FILE) }]) {
    expect(prepareWorkRoot({ ...options, ...overrides })).toBe(workspace)
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
  if (yaml) fs.writeFileSync(file, yaml)
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
  if (kind === 'existing') fs.writeFileSync(pref, JSON.stringify({ dir: 'previous' }))
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
