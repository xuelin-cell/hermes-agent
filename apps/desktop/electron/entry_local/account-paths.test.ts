import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { type AccountRoots, prepareAccountPaths, resolveAccountPaths } from './account-paths'

const temporaryRoots: string[] = []
const namespace = 'maas.ai-yuanjing.com/uniwork'

/** 创建独立根目录，只在夹具中验证文件归属。 */
function fixture(): AccountRoots {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-account-paths-'))
  temporaryRoots.push(root)

  return { data: path.join(root, 'data'), userData: path.join(root, 'desktop') }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('A→B→A 在真实文件系统中分开保存并复用 Home、默认工作区和桌面目录', () => {
  const roots = fixture()
  fs.mkdirSync(roots.data)
  const oldFile = path.join(roots.data, 'old-unowned-data')
  fs.writeFileSync(oldFile, 'preserve-old-data')
  const a = prepareAccountPaths(roots, namespace, 'fixture-A')

  for (const directory of [a.home, a.workspace, a.desktopState]) {
    fs.writeFileSync(path.join(directory, 'marker'), 'fixture-A')
  }

  const b = prepareAccountPaths(roots, namespace, 'fixture-B')
  expect(b.id).not.toBe(a.id)

  for (const directory of [b.home, b.workspace, b.desktopState]) {
    expect(fs.readdirSync(directory)).toEqual([])
    fs.writeFileSync(path.join(directory, 'marker'), 'fixture-B')
  }

  expect(prepareAccountPaths(roots, namespace, 'fixture-A')).toEqual(a)

  for (const directory of [a.home, a.workspace, a.desktopState]) {
    expect(fs.readFileSync(path.join(directory, 'marker'), 'utf8')).toBe('fixture-A')
  }

  expect(fs.readFileSync(oldFile, 'utf8')).toBe('preserve-old-data')
  expect(resolveAccountPaths(roots, 'another-platform/uniwork', 'fixture-A').id).not.toBe(a.id)

  const ids = new Set<string>()

  for (const uid of [
    '../escape',
    '..\\escape',
    'CON',
    'con',
    'NUL',
    'C:\\outside',
    'a/b',
    'a\\b',
    '账号',
    '\ud800',
    '\ufffd'
  ]) {
    const mapped = prepareAccountPaths(roots, namespace, uid)
    expect(mapped.id).toMatch(/^account-[a-f0-9]{64}$/)
    expect(path.relative(roots.data, mapped.workspace)).toBe(path.join('accounts', mapped.id, 'workspace'))
    expect(path.relative(roots.userData, mapped.desktopState)).toBe(path.join('accounts', mapped.id, 'desktop-state'))
    expect(resolveAccountPaths(roots, namespace, uid)).toEqual(mapped)
    expect(ids.has(mapped.id)).toBe(false)
    ids.add(mapped.id)
  }

  for (const uid of ['', ' uid', 'uid ']) {
    expect(() => prepareAccountPaths(roots, namespace, uid)).toThrow()
  }

  expect(() => resolveAccountPaths({ ...roots, data: 'relative' }, namespace, 'A')).toThrow()
  expect(() => resolveAccountPaths(roots, '', 'A')).toThrow()
})

it('受管根、accounts、账号及叶目录的链接或文件占位均拒绝，不写入链接目标', () => {
  for (const location of ['root', 'accounts', 'account', 'home', 'workspace', 'desktopState'] as const) {
    const roots = fixture()
    const paths = resolveAccountPaths(roots, namespace, 'fixture-A')

    const target = {
      root: roots.data,
      accounts: path.join(roots.data, 'accounts'),
      account: path.dirname(paths.home),
      home: paths.home,
      workspace: paths.workspace,
      desktopState: paths.desktopState
    }[location]

    fs.mkdirSync(path.dirname(target), { recursive: true })
    const outside = path.join(path.dirname(roots.data), 'outside')
    fs.mkdirSync(outside)
    // Windows junction 不要求管理员权限；其他平台使用目录符号链接。
    fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => prepareAccountPaths(roots, namespace, 'fixture-A')).toThrow()
    expect(fs.readdirSync(outside)).toEqual([])
    fs.unlinkSync(target)
    fs.writeFileSync(target, 'occupied-file')
    expect(() => prepareAccountPaths(roots, namespace, 'fixture-A')).toThrow()
    expect(fs.readFileSync(target, 'utf8')).toBe('occupied-file')
  }
})
