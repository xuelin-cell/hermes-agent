import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { test } from 'vitest'

import {
  copyTreeNoOverwrite,
  detectOldUniworkUserData,
  MIGRATE_SUBDIRS,
  migrateOldUniworkData,
  MIGRATION_COMPLETED_MARKER,
  MIGRATION_LOG_FILE,
  MIGRATION_TARGET_DIR
} from './migrate-old-uniwork.mjs'

/** 在临时根目录创建测试文件树，并补齐每个文件的父目录。 */
async function makeTree(root: string, structure: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(structure)) {
    const full = path.join(root, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })

    if (content === 'dir') {
      await fs.mkdir(full, { recursive: true })
    } else {
      await fs.writeFile(full, content, 'utf8')
    }
  }
}

test('detectOldUniworkUserData returns null on non-win32', async () => {
  assert.equal(await detectOldUniworkUserData({ APPDATA: '/tmp' }, 'linux'), null)
})

test('detectOldUniworkUserData returns null when APPDATA unset', async () => {
  assert.equal(await detectOldUniworkUserData({}, 'win32'), null)
})

test('detectOldUniworkUserData returns path when dir exists on win32', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uniwork-src-'))
  await fs.mkdir(path.join(dir, 'uniwork'))
  const detected = await detectOldUniworkUserData({ APPDATA: dir }, 'win32')
  assert.equal(detected, path.join(dir, 'uniwork'))
})

test('migrateOldUniworkData is a no-op on non-win32', async () => {
  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const result = await migrateOldUniworkData(newApp, { env: {}, platform: 'linux' })
  assert.equal(result.migrated, false)
  assert.deepEqual(result.failed, [])
  // Target dir should NOT have been created.
  await assert.rejects(() => fs.stat(path.join(newApp, MIGRATION_TARGET_DIR)))
})

test('migrateOldUniworkData copies all four subdirs and writes marker + log', async () => {
  // Build a fake old userData tree under a temp dir, simulating %APPDATA%.
  const appdataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'appdata-'))
  const oldUserData = path.join(appdataRoot, 'uniwork')
  await makeTree(oldUserData, {
    [path.join('conversations', 'chat', 'c1', 'transcript.jsonl')]: 'line1\n',
    [path.join('sessions', 's1', 'outputs', 'out.txt')]: 'output\n',
    [path.join('uploads', 'u.txt')]: 'upload\n',
    [path.join('shares', 'sh.json')]: '{}\n',
    // Out-of-scope subdir — must NOT be copied.
    'config.json': '{}\n'
  })

  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))

  const result = await migrateOldUniworkData(newApp, {
    env: { APPDATA: appdataRoot },
    platform: 'win32'
  })

  assert.equal(result.migrated, true)
  const target = path.join(newApp, MIGRATION_TARGET_DIR)
  assert.equal(result.target, target)

  // All four subdirs copied.
  for (const sub of MIGRATE_SUBDIRS) {
    const stat = await fs.stat(path.join(target, sub))
    assert.equal(stat.isDirectory(), true, `${sub} should be a directory`)
  }

  // Out-of-scope config.json must not exist in target.
  await assert.rejects(() => fs.stat(path.join(target, 'config.json')))

  // Marker + log written.
  const markerStat = await fs.stat(path.join(target, MIGRATION_COMPLETED_MARKER))
  assert.equal(markerStat.isFile(), true)
  const logContent = await fs.readFile(path.join(target, MIGRATION_LOG_FILE), 'utf8')
  assert.match(logContent, /源 userData:/)
  assert.match(logContent, /失败项 \(0\): 无/)
})

test('migrateOldUniworkData skips when .migration_completed already exists', async () => {
  const appdataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'appdata-'))
  const oldUserData = path.join(appdataRoot, 'uniwork')
  await makeTree(oldUserData, { [path.join('uploads', 'u.txt')]: 'upload\n' })

  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const target = path.join(newApp, MIGRATION_TARGET_DIR)
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(path.join(target, MIGRATION_COMPLETED_MARKER), '', 'utf8')
  // Drop a sentinel file that migration would have copied — it should remain
  // absent, proving migration did not run.
  const sentinel = path.join(target, 'uploads', 'u.txt')

  const result = await migrateOldUniworkData(newApp, {
    env: { APPDATA: appdataRoot },
    platform: 'win32'
  })

  assert.equal(result.migrated, false)
  await assert.rejects(() => fs.stat(sentinel))
})

test('migrateOldUniworkData skips missing source subdirs without erroring', async () => {
  // Only create one of the four subdirs; the others are absent.
  const appdataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'appdata-'))
  const oldUserData = path.join(appdataRoot, 'uniwork')
  await makeTree(oldUserData, { [path.join('shares', 'sh.json')]: '{}\n' })

  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))

  const result = await migrateOldUniworkData(newApp, {
    env: { APPDATA: appdataRoot },
    platform: 'win32'
  })

  assert.equal(result.migrated, true)
  assert.deepEqual(result.failed, [])
  const target = path.join(newApp, MIGRATION_TARGET_DIR)
  // The one present subdir was copied.
  const shStat = await fs.stat(path.join(target, 'shares', 'sh.json'))
  assert.equal(shStat.isFile(), true)
  // The absent subdirs were not created in target.
  await assert.rejects(() => fs.stat(path.join(target, 'conversations')))
})

test('copyTreeNoOverwrite does not overwrite existing target files', async () => {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'src-'))
  const dst = await fs.mkdtemp(path.join(os.tmpdir(), 'dst-'))
  await fs.writeFile(path.join(src, 'a.txt'), 'SRC\n', 'utf8')
  await fs.writeFile(path.join(dst, 'a.txt'), 'DST\n', 'utf8')

  await copyTreeNoOverwrite(src, dst)

  const content = await fs.readFile(path.join(dst, 'a.txt'), 'utf8')
  assert.equal(content, 'DST\n')
})

test('migrateOldUniworkData skips source files and completes valid subdirectory copies', async () => {
  const appdataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'appdata-'))
  const oldUserData = path.join(appdataRoot, 'uniwork')
  // conversations 是普通文件，应被跳过；有效 uploads 目录仍应正常复制。
  await makeTree(oldUserData, {
    conversations: 'not-a-dir\n',
    [path.join('uploads', 'u.txt')]: 'upload\n'
  })

  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))

  const result = await migrateOldUniworkData(newApp, {
    env: { APPDATA: appdataRoot },
    platform: 'win32'
  })

  // `conversations` (a file, not a dir) is skipped by the isDirectory() guard,
  // not recorded as a failure. The valid `uploads` subdir is still copied, and
  // the marker is still written.
  assert.equal(result.migrated, true)
  assert.deepEqual(result.failed, [])
  const target = path.join(newApp, MIGRATION_TARGET_DIR)
  await fs.stat(path.join(target, MIGRATION_COMPLETED_MARKER))
  await fs.stat(path.join(target, 'uploads', 'u.txt'))
})
