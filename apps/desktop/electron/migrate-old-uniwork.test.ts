import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { test } from 'vitest'

import {
  copyTreeNoOverwrite,
  defaultRunner,
  detectMacOldUniwork,
  detectOldUniworkUserData,
  extractMacSessionsFromVm,
  MAC_HOST_USERDATA_SUBPATH,
  MAC_LIMA_HOME_SUBDIR,
  MAC_LIMA_INSTANCE,
  MIGRATE_SUBDIRS,
  migrateMacOldUniworkData,
  migrateOldUniworkData,
  migrateOldUniworkToWorkspace,
  MIGRATION_COMPLETED_MARKER,
  MIGRATION_LOG_FILE,
  MIGRATION_TARGET_DIR,
  VM_TAR_PATH,
  HOST_TAR_PATH
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

/** 构造一个始终成功并记录调用的 mock runner。 */
function makeMockRunner(): { runner: typeof defaultRunner; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const runner = (async (cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    return { exitCode: 0, stdout: '', stderr: '' }
  }) as typeof defaultRunner
  return { runner, calls }
}

// ============================================================
// Plan A — Windows (existing tests, preserved)
// ============================================================

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

test('migrateOldUniworkData skips when the legacy folder is the app userData root', async () => {
  // The app's userData root is named uniwork, the legacy folder name: source
  // and destination are the same directory, so nothing may be copied.
  const appdataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'appdata-'))
  const userData = path.join(appdataRoot, 'uniwork')
  await makeTree(userData, { [path.join('uploads', 'u.txt')]: 'upload\n' })

  const result = await migrateOldUniworkData(userData, {
    env: { APPDATA: appdataRoot },
    platform: 'win32'
  })

  assert.equal(result.migrated, false)
  await assert.rejects(() => fs.stat(path.join(userData, MIGRATION_TARGET_DIR)))
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

// ============================================================
// Plan A — macOS (new tests)
// ============================================================

test('detectMacOldUniwork returns null on non-darwin', async () => {
  const result = await detectMacOldUniwork({}, 'linux', '/home/test')
  assert.deepEqual(result, { hostUserData: null, limaHome: null })
})

test('detectMacOldUniwork detects host userData and lima home when both exist', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'))
  const hostUserData = path.join(home, ...MAC_HOST_USERDATA_SUBPATH)
  const limaHome = path.join(home, MAC_LIMA_HOME_SUBDIR)
  await fs.mkdir(hostUserData, { recursive: true })
  await fs.mkdir(limaHome, { recursive: true })

  const result = await detectMacOldUniwork({}, 'darwin', home)

  assert.equal(result.hostUserData, hostUserData)
  assert.equal(result.limaHome, limaHome)
})

test('detectMacOldUniwork returns null for both when neither exists', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'))
  const result = await detectMacOldUniwork({}, 'darwin', home)
  assert.equal(result.hostUserData, null)
  assert.equal(result.limaHome, null)
})

test('migrateMacOldUniworkData is a no-op on non-darwin', async () => {
  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const result = await migrateMacOldUniworkData(newApp, { env: {}, platform: 'linux' })
  assert.equal(result.migrated, false)
  assert.deepEqual(result.failed, [])
  await assert.rejects(() => fs.stat(path.join(newApp, MIGRATION_TARGET_DIR)))
})

test('migrateMacOldUniworkData returns not migrated when neither host nor lima detected', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'))
  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))

  const result = await migrateMacOldUniworkData(newApp, {
    env: {},
    platform: 'darwin',
    home
  })

  assert.equal(result.migrated, false)
})

test('migrateMacOldUniworkData is idempotent when marker already exists', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'))
  const hostUserData = path.join(home, ...MAC_HOST_USERDATA_SUBPATH)
  await fs.mkdir(path.join(hostUserData, 'conversations'), { recursive: true })

  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const target = path.join(newApp, MIGRATION_TARGET_DIR)
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(path.join(target, MIGRATION_COMPLETED_MARKER), '', 'utf8')

  const result = await migrateMacOldUniworkData(newApp, {
    env: {},
    platform: 'darwin',
    home
  })

  assert.equal(result.migrated, false)
})

test('migrateMacOldUniworkData retries a marked migration when Lima sessions are missing', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'))
  await fs.mkdir(path.join(home, MAC_LIMA_HOME_SUBDIR), { recursive: true })
  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const target = path.join(newApp, MIGRATION_TARGET_DIR)
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(path.join(target, MIGRATION_COMPLETED_MARKER), '', 'utf8')

  const { runner, calls } = makeMockRunner()
  const result = await migrateMacOldUniworkData(newApp, {
    env: {},
    platform: 'darwin',
    home,
    runner
  })

  assert.equal(result.migrated, true)
  assert.deepEqual(calls[0].args, ['list', '--json'])
  assert.equal(await fs.stat(path.join(target, 'sessions')).then(stat => stat.isDirectory()), true)
})

test('migrateMacOldUniworkData copies host conversations with mock runner (no lima home)', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'))
  const hostUserData = path.join(home, ...MAC_HOST_USERDATA_SUBPATH)
  await makeTree(hostUserData, {
    [path.join('conversations', 'chat', 'transcript.jsonl')]: 'line1\n'
  })
  // No lima home — only host conversations should be copied.

  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))

  const result = await migrateMacOldUniworkData(newApp, {
    env: {},
    platform: 'darwin',
    home,
    runner: makeMockRunner().runner
  })

  assert.equal(result.migrated, true)
  const target = path.join(newApp, MIGRATION_TARGET_DIR)
  const convStat = await fs.stat(path.join(target, 'conversations', 'chat', 'transcript.jsonl'))
  assert.equal(convStat.isFile(), true)
  const markerStat = await fs.stat(path.join(target, MIGRATION_COMPLETED_MARKER))
  assert.equal(markerStat.isFile(), true)
})

// ============================================================
// extractMacSessionsFromVm — mock runner tests
// ============================================================

test('extractMacSessionsFromVm returns not ok on non-darwin', async () => {
  const result = await extractMacSessionsFromVm('/tmp/target', {
    env: {},
    platform: 'linux',
    home: '/tmp/home'
  })
  assert.equal(result.ok, false)
})

test('extractMacSessionsFromVm verifies correct limactl command sequence', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'))
  const limaHome = path.join(home, MAC_LIMA_HOME_SUBDIR)
  await fs.mkdir(limaHome, { recursive: true })

  const { runner, calls } = makeMockRunner()

  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'target-'))
  const result = await extractMacSessionsFromVm(target, {
    env: {},
    platform: 'darwin',
    home,
    runner
  })

  assert.equal(result.ok, true)

  // Verify the expected sequence of commands.
  // 1. limactl list --json (availability check)
  assert.equal(calls[0].cmd, 'limactl')
  assert.deepEqual(calls[0].args, ['list', '--json'])

  // 2. limactl start hexagent --tty=false
  assert.equal(calls[1].cmd, 'limactl')
  assert.deepEqual(calls[1].args, ['start', MAC_LIMA_INSTANCE, '--tty=false'])

  // 3. limactl shell hexagent -- true (ready probe)
  assert.equal(calls[2].cmd, 'limactl')
  assert.deepEqual(calls[2].args, ['shell', MAC_LIMA_INSTANCE, '--', 'true'])

  // 4. limactl shell hexagent -- bash -c "sudo tar ..."
  assert.equal(calls[3].cmd, 'limactl')
  assert.equal(calls[3].args[0], 'shell')
  assert.equal(calls[3].args[1], MAC_LIMA_INSTANCE)
  assert.equal(calls[3].args[3], 'bash')
  assert.match(calls[3].args[5], /sudo tar -czf/)
  assert.match(calls[3].args[5], /--one-file-system/)

  // 5. limactl copy hexagent:/tmp/sessions.tar.gz /tmp/sessions.tar.gz
  assert.equal(calls[4].cmd, 'limactl')
  assert.deepEqual(calls[4].args, ['copy', `${MAC_LIMA_INSTANCE}:${VM_TAR_PATH}`, HOST_TAR_PATH])

  // 6. tar -xzf /tmp/sessions.tar.gz -C <target>/sessions --strip-components=1
  assert.equal(calls[5].cmd, 'tar')
  assert.equal(calls[5].args[0], '-xzf')
  assert.equal(calls[5].args[1], HOST_TAR_PATH)
  assert.match(calls[5].args[3], /sessions$/)
  assert.equal(calls[5].args[4], '--strip-components=1')

  // 7. limactl shell hexagent -- bash -c "sudo rm -f /tmp/sessions.tar.gz" (cleanup)
  assert.equal(calls[6].cmd, 'limactl')
  assert.match(calls[6].args[5], /sudo rm -f/)
})

test('extractMacSessionsFromVm returns not ok when limactl unavailable', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'))
  const limaHome = path.join(home, MAC_LIMA_HOME_SUBDIR)
  await fs.mkdir(limaHome, { recursive: true })

  // Mock runner that fails the availability check.
  const runner = (async () => ({
    exitCode: 1,
    stdout: '',
    stderr: 'limactl not found'
  })) as typeof defaultRunner

  const result = await extractMacSessionsFromVm('/tmp/target', {
    env: {},
    platform: 'darwin',
    home,
    runner
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /limactl 不可用/)
})

test('extractMacSessionsFromVm returns not ok when VM start fails', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'))
  const limaHome = path.join(home, MAC_LIMA_HOME_SUBDIR)
  await fs.mkdir(limaHome, { recursive: true })

  // Mock runner: availability check passes, but VM start fails.
  let callCount = 0
  const runner = (async () => {
    callCount++
    if (callCount === 1) {
      return { exitCode: 0, stdout: '', stderr: '' }  // list --json
    }
    return { exitCode: 1, stdout: '', stderr: 'start failed' }  // start fails
  }) as typeof defaultRunner

  const result = await extractMacSessionsFromVm('/tmp/target', {
    env: {},
    platform: 'darwin',
    home,
    runner
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /Lima VM 启动失败/)
})

// ============================================================
// Plan B — account-isolated migration (new tests)
// ============================================================

test('migrateOldUniworkToWorkspace is a no-op on non-win32/darwin', async () => {
  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-'))
  const result = await migrateOldUniworkToWorkspace(newApp, workspace, {
    env: {},
    platform: 'linux'
  })
  assert.equal(result.migrated, false)
  assert.deepEqual(result.failed, [])
})

test('migrateOldUniworkToWorkspace skips when Plan A source does not exist', async () => {
  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-'))

  const result = await migrateOldUniworkToWorkspace(newApp, workspace, {
    env: {},
    platform: 'win32'
  })

  assert.equal(result.migrated, false)
  assert.equal(result.target, '')
})

test('migrateOldUniworkToWorkspace skips when Plan A completion marker is missing', async () => {
  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-'))

  // Create Plan A target dir but no marker.
  const planATarget = path.join(newApp, MIGRATION_TARGET_DIR)
  await fs.mkdir(planATarget, { recursive: true })

  const result = await migrateOldUniworkToWorkspace(newApp, workspace, {
    env: {},
    platform: 'win32'
  })

  assert.equal(result.migrated, false)
})

test('migrateOldUniworkToWorkspace copies Plan A product into workspace', async () => {
  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-'))

  // Build Plan A product with all 4 subdirs + marker.
  const planATarget = path.join(newApp, MIGRATION_TARGET_DIR)
  await makeTree(planATarget, {
    [path.join('conversations', 'c1.jsonl')]: 'line1\n',
    [path.join('sessions', 's1', 'out.txt')]: 'out\n',
    [path.join('uploads', 'u.txt')]: 'upload\n',
    [path.join('shares', 'sh.json')]: '{}\n'
  })
  await fs.writeFile(path.join(planATarget, MIGRATION_COMPLETED_MARKER), '', 'utf8')

  const result = await migrateOldUniworkToWorkspace(newApp, workspace, {
    env: {},
    platform: 'win32'
  })

  assert.equal(result.migrated, true)
  const target = path.join(workspace, MIGRATION_TARGET_DIR)
  assert.equal(result.target, target)

  // All four subdirs copied.
  for (const sub of MIGRATE_SUBDIRS) {
    const stat = await fs.stat(path.join(target, sub))
    assert.equal(stat.isDirectory(), true, `${sub} should be a directory`)
  }

  // Marker + log written.
  const markerStat = await fs.stat(path.join(target, MIGRATION_COMPLETED_MARKER))
  assert.equal(markerStat.isFile(), true)
  const logContent = await fs.readFile(path.join(target, MIGRATION_LOG_FILE), 'utf8')
  assert.match(logContent, /Plan A 源:/)
  assert.match(logContent, /Plan B 目标:/)
})

test('migrateOldUniworkToWorkspace is idempotent per account', async () => {
  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-'))

  // Plan A product.
  const planATarget = path.join(newApp, MIGRATION_TARGET_DIR)
  await makeTree(planATarget, {
    [path.join('uploads', 'u.txt')]: 'upload\n'
  })
  await fs.writeFile(path.join(planATarget, MIGRATION_COMPLETED_MARKER), '', 'utf8')

  // First run migrates.
  const result1 = await migrateOldUniworkToWorkspace(newApp, workspace, {
    env: {},
    platform: 'win32'
  })
  assert.equal(result1.migrated, true)

  // Second run on the same account is skipped (idempotent).
  const result2 = await migrateOldUniworkToWorkspace(newApp, workspace, {
    env: {},
    platform: 'win32'
  })
  assert.equal(result2.migrated, false)
})

test('migrateOldUniworkToWorkspace repairs marked macOS migration when Plan A gains sessions', async () => {
  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-'))
  const planATarget = path.join(newApp, MIGRATION_TARGET_DIR)
  const workspaceTarget = path.join(workspace, MIGRATION_TARGET_DIR)
  await makeTree(planATarget, { [path.join('sessions', 'recovered', 'state.json')]: '{}' })
  await fs.writeFile(path.join(planATarget, MIGRATION_COMPLETED_MARKER), '', 'utf8')
  await fs.mkdir(workspaceTarget, { recursive: true })
  await fs.writeFile(path.join(workspaceTarget, MIGRATION_COMPLETED_MARKER), '', 'utf8')

  const result = await migrateOldUniworkToWorkspace(newApp, workspace, {
    env: {},
    platform: 'darwin'
  })

  assert.equal(result.migrated, true)
  assert.equal(
    await fs.stat(path.join(workspaceTarget, 'sessions', 'recovered', 'state.json')).then(stat => stat.isFile()),
    true
  )
})

test('migrateOldUniworkToWorkspace awaits planAPromise before proceeding', async () => {
  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-'))

  // Plan A product with marker.
  const planATarget = path.join(newApp, MIGRATION_TARGET_DIR)
  await makeTree(planATarget, {
    [path.join('shares', 'sh.json')]: '{}\n'
  })
  await fs.writeFile(path.join(planATarget, MIGRATION_COMPLETED_MARKER), '', 'utf8')

  // planAPromise that resolves after a short delay.
  let planAResolved = false
  const planAPromise = new Promise(resolve => {
    setTimeout(() => {
      planAResolved = true
      resolve(undefined)
    }, 50)
  })

  const result = await migrateOldUniworkToWorkspace(newApp, workspace, {
    env: {},
    platform: 'win32',
    planAPromise
  })

  assert.equal(result.migrated, true)
  assert.equal(planAResolved, true)
})

test('migrateOldUniworkToWorkspace skips missing source subdirs', async () => {
  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-'))

  // Plan A product with only one subdir + marker.
  const planATarget = path.join(newApp, MIGRATION_TARGET_DIR)
  await makeTree(planATarget, {
    [path.join('shares', 'sh.json')]: '{}\n'
  })
  await fs.writeFile(path.join(planATarget, MIGRATION_COMPLETED_MARKER), '', 'utf8')

  const result = await migrateOldUniworkToWorkspace(newApp, workspace, {
    env: {},
    platform: 'win32'
  })

  assert.equal(result.migrated, true)
  assert.deepEqual(result.failed, [])
  const target = path.join(workspace, MIGRATION_TARGET_DIR)
  // The one present subdir was copied.
  const shStat = await fs.stat(path.join(target, 'shares', 'sh.json'))
  assert.equal(shStat.isFile(), true)
  // The absent subdirs were not created.
  await assert.rejects(() => fs.stat(path.join(target, 'conversations')))
})

test('migrateOldUniworkToWorkspace does not overwrite existing workspace files', async () => {
  const newApp = await fs.mkdtemp(path.join(os.tmpdir(), 'newapp-'))
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-'))

  // Plan A product.
  const planATarget = path.join(newApp, MIGRATION_TARGET_DIR)
  await makeTree(planATarget, {
    [path.join('uploads', 'u.txt')]: 'SRC\n'
  })
  await fs.writeFile(path.join(planATarget, MIGRATION_COMPLETED_MARKER), '', 'utf8')

  // Pre-existing workspace file that should NOT be overwritten.
  const workspaceTarget = path.join(workspace, MIGRATION_TARGET_DIR)
  await makeTree(workspaceTarget, {
    [path.join('uploads', 'u.txt')]: 'DST\n'
  })

  await migrateOldUniworkToWorkspace(newApp, workspace, {
    env: {},
    platform: 'win32'
  })

  const content = await fs.readFile(path.join(workspaceTarget, 'uploads', 'u.txt'), 'utf8')
  assert.equal(content, 'DST\n')
})
