import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { DEV_EXTRAS, ensureDevExtras, recordedExtras } from './dev-extras'
import type { PreparedLocalContext } from './runtime-context'

/** 按 PM 的目录规则写一份已选组件记录。 */
function fixture(extras?: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mt-extras-'))
  const source = path.join(root, 'source')
  const home = path.join(root, 'home')
  fs.mkdirSync(source)

  if (extras !== undefined) {
    const key = createHash('sha256').update(fs.realpathSync.native(source)).digest('hex').slice(0, 16)
    const dir = path.join(home, 'installs', key)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify({ packages: { venv: { extras } } }))
  }

  const context = {
    home,
    installationRoot: source,
    python: path.join(source, 'python.exe')
  } as PreparedLocalContext

  return { context, home, source }
}

it('读取 PM 为本源码目录记录的组件；没有记录表示账号还没有自己的环境', () => {
  const { home, source } = fixture(['mcp', 7, 'anthropic'])

  expect(recordedExtras(home, source)).toEqual(['mcp', 'anthropic'])
  expect(recordedExtras(home, path.join(source, 'other'))).toBeNull()
  expect(recordedExtras(fixture().home, source)).toBeNull()
})

it('新账号同样补装声明组件，已有环境仅追加缺项且不丢失其他组件', async () => {
  const run = vi.fn(async () => true)
  const partial = fixture(['mcp'])

  await ensureDevExtras(partial.context, {}, run)
  expect(run).toHaveBeenCalledWith(partial.context, {}, ['messaging'])

  run.mockClear()
  await ensureDevExtras(fixture([]).context, {}, run)
  expect(run).toHaveBeenCalledWith(expect.anything(), {}, [...DEV_EXTRAS])

  run.mockClear()
  await ensureDevExtras(fixture([...DEV_EXTRAS, 'dingtalk']).context, {}, run)
  expect(run).not.toHaveBeenCalled()

  const fresh = fixture()
  await ensureDevExtras(fresh.context, {}, run)
  expect(run).toHaveBeenCalledWith(fresh.context, {}, [...DEV_EXTRAS])
})

it('安装版不预装；预装失败只记日志，不中断启动', async () => {
  const run = vi.fn(async () => false)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const { context } = fixture(['mcp'])

  await ensureDevExtras({ ...context, sitePackages: 'bundled-site-packages' }, {}, run)
  vi.stubEnv('HERMES_DESKTOP_MT_SKIP_DEV_EXTRAS', '1')
  await ensureDevExtras(context, {}, run)
  vi.unstubAllEnvs()
  expect(run).not.toHaveBeenCalled()

  await expect(ensureDevExtras(context, {}, run)).resolves.toBeUndefined()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('messaging'))
  expect(String(warn.mock.calls[0][0])).not.toContain(context.home)
  warn.mockRestore()
})
