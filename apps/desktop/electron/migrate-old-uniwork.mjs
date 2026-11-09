// migrate-old-uniwork.mjs — pure Node migration core for legacy UniWork
// userData. No Electron imports; only node:fs, node:path, node:os,
// node:child_process, node:util. The app imports this through
// migrate-old-uniwork.ts (a typed re-export), and tests import the .mjs
// directly because Node's type-stripping cannot resolve extensionless
// TypeScript imports.
//
// Two-tier architecture:
//   Plan A — global pre-login migration (Windows + macOS).
//            Copies legacy data into <userData>/old_uniwork_data/.
//   Plan B — per-account post-login migration (platform-agnostic).
//            Copies Plan A's product into <workspace>/old_uniwork_data/.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ============================================================
// Constants
// ============================================================

/**
 * Subdirectories of the legacy userData that are in scope for migration.
 * Everything else under userData (configs, plugins, logs, deps, ...) is left
 * untouched.
 */
export const MIGRATE_SUBDIRS = ['conversations', 'sessions', 'uploads', 'shares']

/** Directory name under the new app userData that holds the migrated backup. */
export const MIGRATION_TARGET_DIR = 'old_uniwork_data'

/** Marker file written into the migration target once migration completes. */
export const MIGRATION_COMPLETED_MARKER = '.migration_completed'

/** Log file recording migration run details. */
export const MIGRATION_LOG_FILE = 'migration_log.txt'

// ── macOS Lima-related constants ──────────────────────────────────

/** Lima home subdirectory (relative to home) — UniWork's dedicated Lima home. */
export const MAC_LIMA_HOME_SUBDIR = '.lima-uniwork'

/** Lima instance name (hardcoded). */
export const MAC_LIMA_INSTANCE = 'hexagent'

/** Subpath components for the legacy host userData on macOS. */
export const MAC_HOST_USERDATA_SUBPATH = ['Library', 'Application Support', 'uniwork']

/** VM internal directory to extract (sessions root). */
export const VM_EXTRACT_DIR = '/sessions'

/** Path inside the VM where the tar archive is created. */
export const VM_TAR_PATH = '/tmp/sessions.tar.gz'

/** Path on the host where the tar archive is copied to. */
export const HOST_TAR_PATH = '/tmp/sessions.tar.gz'

// ============================================================
// Shared utilities
// ============================================================

/** Promise-based sleep. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Default sub-process runner. Executes `cmd` with `args` and returns a
 * normalized result. Injected as `runner` in tests to avoid real limactl
 * invocation.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: object, timeout?: number }} [opts]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export async function defaultRunner(cmd, args, { env, timeout } = {}) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      env,
      timeout,
      maxBuffer: 1024 * 1024 * 256
    })
    return { exitCode: 0, stdout, stderr }
  } catch (error) {
    return {
      exitCode: typeof error.status === 'number'
        ? error.status
        : (error.code === 'ENOENT' ? 127 : 1),
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message
    }
  }
}

// ============================================================
// Plan A — Windows (existing logic, extracted)
// ============================================================

/**
 * Resolve the legacy UniWork app userData directory on Windows.
 *
 * Electron uses the `name` field from package.json (here `uniwork`, all
 * lowercase) as the userData leaf directory on Windows — NOT `productName`
 * (`UniWork`). Returns `null` when not on Windows, when APPDATA is unset, or
 * when the resolved directory does not exist / is not a directory.
 *
 * @param {object} [env=process.env]
 * @param {string} [platform=process.platform]
 * @returns {Promise<string|null>}
 */
export async function detectOldUniworkUserData(env = process.env, platform = process.platform) {
  if (platform !== 'win32') {
    return null
  }
  const appdata = (env.APPDATA || '').trim()
  if (!appdata) {
    return null
  }
  const candidate = path.join(appdata, 'uniwork')
  try {
    const stat = await fs.stat(candidate)
    if (!stat.isDirectory()) {
      return null
    }
  } catch {
    return null
  }
  return candidate
}

/**
 * Recursively copy src into dst, skipping any target file/dir that already
 * exists (no-overwrite). Relative structure is preserved. A missing source
 * is a no-op (caller decides whether to skip).
 *
 * @param {string} src - source directory (must exist)
 * @param {string} dst - destination directory (created if missing)
 * @returns {Promise<void>}
 */
export async function copyTreeNoOverwrite(src, dst) {
  await fs.mkdir(dst, { recursive: true })
  let entries
  try {
    entries = await fs.readdir(src, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOTDIR') {
      return
    }
    throw error
  }
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyTreeNoOverwrite(srcPath, dstPath)
    } else if (entry.isFile()) {
      let exists = false
      try {
        await fs.stat(dstPath)
        exists = true
      } catch {
        exists = false
      }
      if (exists) {
        continue
      }
      await fs.mkdir(path.dirname(dstPath), { recursive: true })
      await fs.copyFile(srcPath, dstPath)
    }
  }
}

async function isDirectory(directory) {
  try {
    return (await fs.stat(directory)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Windows Plan A: migrate legacy UniWork userData subdirectories into the new
 * app userData under `old_uniwork_data/`.
 *
 * Behaviour:
 * - Non-win32 → returns { migrated: false } without touching the filesystem.
 * - If legacy userData not detected → returns { migrated: false }.
 * - If `.migration_completed` marker already exists → returns { migrated: false }
 *   (already migrated; skip).
 * - For each subdir in MIGRATE_SUBDIRS:
 *   - If the source subdir doesn't exist → skip (user never used this feature).
 *   - Otherwise copy recursively into the target, no-overwrite.
 *   - A single subdir failure is caught and recorded in `failed`; it does not
 *     abort the overall migration.
 * - Writes `migration_log.txt` with run details (best-effort).
 * - Writes `.migration_completed` marker last, even when some subdirs failed,
 *   so a half-finished run is not retried on every launch.
 *
 * @param {string} newAppUserData - new app userData directory (e.g. %APPDATA%\hmt)
 * @param {object} [options]
 * @param {object} [options.env=process.env]
 * @param {string} [options.platform=process.platform]
 * @param {function(string): void} [options.log] - optional debug sink
 * @returns {Promise<{ migrated: boolean, target: string, failed: string[] }>}
 */
export async function migrateWinOldUniworkData(newAppUserData, { env, platform, log } = {}) {
  env = env || process.env
  platform = platform || process.platform
  const failed = []

  if (platform !== 'win32') {
    return { migrated: false, target: '', failed }
  }

  const oldUserData = await detectOldUniworkUserData(env, platform)
  if (oldUserData === null) {
    return { migrated: false, target: '', failed }
  }

  const target = path.join(newAppUserData, MIGRATION_TARGET_DIR)
  await fs.mkdir(target, { recursive: true })

  // Idempotency: skip if already migrated.
  const marker = path.join(target, MIGRATION_COMPLETED_MARKER)
  try {
    await fs.stat(marker)
    return { migrated: false, target, failed }
  } catch {
    // marker doesn't exist — proceed
  }

  // Migrate each in-scope subdir.
  for (const subdir of MIGRATE_SUBDIRS) {
    const src = path.join(oldUserData, subdir)
    const dst = path.join(target, subdir)

    try {
      const stat = await fs.stat(src)
      if (!stat.isDirectory()) {
        continue
      }
    } catch {
      // Source subdir doesn't exist — skip silently (empty dir handling).
      continue
    }

    try {
      await copyTreeNoOverwrite(src, dst)
    } catch (error) {
      failed.push(`${subdir}: ${error.message || error}`)
    }
  }

  // Write migration log (best-effort, never aborts on failure).
  const logFile = path.join(target, MIGRATION_LOG_FILE)
  try {
    const content = [
      `迁移时间: ${new Date().toISOString()}`,
      `平台: win32`,
      `源 userData: ${oldUserData}`,
      `迁移目标: ${target}`,
      `迁移子目录: ${MIGRATE_SUBDIRS.join(', ')}`,
      `失败项 (${failed.length}): ${failed.length > 0 ? failed.join('; ') : '无'}`
    ].join('\n') + '\n'
    await fs.writeFile(logFile, content, 'utf8')
  } catch (error) {
    failed.push(`${MIGRATION_LOG_FILE}: ${error.message || error}`)
  }

  // Mark migration complete (always, even with failures — idempotency).
  try {
    await fs.writeFile(marker, '', 'utf8')
  } catch (error) {
    failed.push(`${MIGRATION_COMPLETED_MARKER}: ${error.message || error}`)
  }

  if (typeof log === 'function') {
    log(`migrate-old-uniwork(win): ${failed.length} failures`)
  }

  return { migrated: true, target, failed }
}

// ============================================================
// Plan A — macOS (new)
// ============================================================

/**
 * Detect macOS legacy data in two storage locations:
 *   1. Host userData: ~/Library/Application Support/uniwork/ (conversations/)
 *   2. Lima home:     ~/.lima-uniwork/                       (VM sessions/)
 *
 * Each is returned as `string | null` — they are independent (one may exist
 * without the other). Returns `{ hostUserData: null, limaHome: null }` on
 * non-darwin platforms.
 *
 * @param {object} [env=process.env]
 * @param {string} [platform=process.platform]
 * @param {string} [home=os.homedir()]
 * @returns {Promise<{ hostUserData: string|null, limaHome: string|null }>}
 */
export async function detectMacOldUniwork(
  env = process.env,
  platform = process.platform,
  home = os.homedir()
) {
  if (platform !== 'darwin') {
    return { hostUserData: null, limaHome: null }
  }

  const hostUserData = path.join(home, ...MAC_HOST_USERDATA_SUBPATH)
  const limaHome = path.join(home, MAC_LIMA_HOME_SUBDIR)

  let host = null
  try {
    const stat = await fs.stat(hostUserData)
    if (stat.isDirectory()) {
      host = hostUserData
    }
  } catch {
    // host userData doesn't exist
  }

  let lima = null
  try {
    const stat = await fs.stat(limaHome)
    if (stat.isDirectory()) {
      lima = limaHome
    }
  } catch {
    // lima home doesn't exist
  }

  return { hostUserData: host, limaHome: lima }
}

/**
 * Check whether `limactl` is available and the Lima home is valid.
 *
 * @param {string} limaHome
 * @param {Function} runner
 * @param {object} env
 * @returns {Promise<boolean>}
 */
async function isLimaAvailable(limaHome, runner, env) {
  const childEnv = { ...env, LIMA_HOME: limaHome }
  const result = await runner('limactl', ['list', '--json'], { env: childEnv, timeout: 30000 })
  return result.exitCode === 0
}

/**
 * Start the Lima VM (idempotent — no-op if already running).
 *
 * @param {string} limaHome
 * @param {string} instance
 * @param {Function} runner
 * @param {object} env
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function startLimaVm(limaHome, instance, runner, env) {
  const childEnv = { ...env, LIMA_HOME: limaHome }

  // 1. Start VM (blocks until ready).
  const startR = await runner(
    'limactl',
    ['start', instance, '--tty=false'],
    { env: childEnv, timeout: 300000 }
  )
  if (startR.exitCode !== 0) {
    return { ok: false, message: `Lima VM 启动失败: ${startR.stderr || startR.stdout}` }
  }

  // 2. Wait for VM ready (shell probe, retry 3 times, 5s interval).
  let ready = false
  for (let i = 0; i < 3; i++) {
    const probe = await runner(
      'limactl',
      ['shell', instance, '--', 'true'],
      { env: childEnv, timeout: 60000 }
    )
    if (probe.exitCode === 0) {
      ready = true
      break
    }
    if (i < 2) {
      await sleep(5000)
    }
  }
  if (!ready) {
    return { ok: false, message: 'Lima VM 就绪超时' }
  }

  return { ok: true, message: '' }
}

/**
 * Extract /sessions/ from the Lima VM into <migrationTarget>/sessions/.
 *
 * Flow (all limactl commands carry LIMA_HOME=<limaHome>):
 *   1. Start VM (idempotent, blocks until ready)
 *   2. VM-internal: sudo tar -czf /tmp/sessions.tar.gz --one-file-system -C / sessions
 *      (--one-file-system skips virtiofs bind mounts)
 *   3. limactl copy <instance>:/tmp/sessions.tar.gz /tmp/sessions.tar.gz
 *   4. Host-internal: tar -xzf /tmp/sessions.tar.gz -C <target>/sessions --strip-components=1
 *   5. Cleanup VM + host temp tar (best-effort)
 *
 * @param {string} migrationTarget - the old_uniwork_data directory
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function extractMacSessionsFromVm(
  migrationTarget,
  { env = process.env, platform = process.platform, home = os.homedir(), runner = defaultRunner, log } = {}
) {
  if (platform !== 'darwin') {
    return { ok: false, message: '非 macOS 平台' }
  }

  const limaHome = path.join(home, MAC_LIMA_HOME_SUBDIR)
  const childEnv = { ...env, LIMA_HOME: limaHome }

  // Check limactl availability first.
  if (!(await isLimaAvailable(limaHome, runner, env))) {
    return { ok: false, message: 'limactl 不可用或 Lima home 无效' }
  }

  // 1. Start VM.
  const startResult = await startLimaVm(limaHome, MAC_LIMA_INSTANCE, runner, env)
  if (!startResult.ok) {
    return startResult
  }

  // 2. VM-internal sudo tar (create archive).
  const tarCmd = `sudo tar -czf ${VM_TAR_PATH} --one-file-system -C / sessions`
  const tarR = await runner(
    'limactl',
    ['shell', MAC_LIMA_INSTANCE, '--', 'bash', '-c', tarCmd],
    { env: childEnv, timeout: 300000 }
  )
  if (tarR.exitCode !== 0) {
    return { ok: false, message: `VM 内 tar 打包失败: ${tarR.stderr || tarR.stdout}` }
  }

  // 3. Copy tar from VM to host.
  const copyR = await runner(
    'limactl',
    ['copy', `${MAC_LIMA_INSTANCE}:${VM_TAR_PATH}`, HOST_TAR_PATH],
    { env: childEnv, timeout: 300000 }
  )
  if (copyR.exitCode !== 0) {
    return { ok: false, message: `limactl copy 失败: ${copyR.stderr || copyR.stdout}` }
  }

  // 4. Host-internal extract (--strip-components=1 drops the leading sessions/).
  const sessionsTarget = path.join(migrationTarget, 'sessions')
  await fs.mkdir(sessionsTarget, { recursive: true })
  const extractR = await runner(
    'tar',
    ['-xzf', HOST_TAR_PATH, '-C', sessionsTarget, '--strip-components=1'],
    { env: childEnv, timeout: 300000 }
  )
  if (extractR.exitCode !== 0) {
    return { ok: false, message: `宿主解压失败: ${extractR.stderr || extractR.stdout}` }
  }

  // 5. Cleanup (best-effort).
  await runner(
    'limactl',
    ['shell', MAC_LIMA_INSTANCE, '--', 'bash', '-c', `sudo rm -f ${VM_TAR_PATH}`],
    { env: childEnv, timeout: 60000 }
  ).catch(() => {})
  try {
    await fs.unlink(HOST_TAR_PATH)
  } catch {
    // ignore
  }

  if (typeof log === 'function') {
    log('extractMacSessionsFromVm: sessions/ extracted from Lima VM')
  }

  return { ok: true, message: 'sessions/ 从 Lima VM 提取成功' }
}

/**
 * macOS Plan A: migrate legacy UniWork data into the new app userData under
 * `old_uniwork_data/`. Two storage locations are handled independently:
 *
 *   Storage 1 — Host userData conversations/ (direct recursive copy)
 *   Storage 2 — Lima VM /sessions/ (start VM + sudo tar + limactl copy + extract)
 *
 * Behaviour:
 * - Non-darwin → returns { migrated: false } without touching the filesystem.
 * - If neither host userData nor Lima home detected → returns { migrated: false }.
 * - If `.migration_completed` marker already exists → returns { migrated: false }.
 * - Host conversations cp failure → recorded in `failed`, does not abort.
 * - Lima VM extraction failure → recorded in `failed`, does not abort.
 * - Writes `migration_log.txt` (best-effort).
 * - Writes `.migration_completed` marker (even with partial failures → idempotent).
 *
 * @param {string} newAppUserData
 * @param {object} [options]
 * @returns {Promise<{ migrated: boolean, target: string, failed: string[] }>}
 */
export async function migrateMacOldUniworkData(
  newAppUserData,
  { env = process.env, platform = process.platform, home = os.homedir(), runner = defaultRunner, log } = {}
) {
  const failed = []

  if (platform !== 'darwin') {
    return { migrated: false, target: '', failed }
  }

  const { hostUserData, limaHome } = await detectMacOldUniwork(env, platform, home)
  if (hostUserData === null && limaHome === null) {
    return { migrated: false, target: '', failed }
  }

  const target = path.join(newAppUserData, MIGRATION_TARGET_DIR)
  await fs.mkdir(target, { recursive: true })

  // Idempotency: skip if already migrated.
  const marker = path.join(target, MIGRATION_COMPLETED_MARKER)
  try {
    await fs.stat(marker)
    // Older builds wrote this marker even when Lima extraction failed. Resume
    // only the still-missing directory so an upgrade can repair the migration.
    const shouldRepairVmSessions = limaHome !== null && !(await isDirectory(path.join(target, 'sessions')))
    if (!shouldRepairVmSessions) {
      return { migrated: false, target, failed }
    }
  } catch {
    // marker doesn't exist — proceed
  }

  // ── Storage 1: Host userData conversations/ cp ──────────────────
  if (hostUserData !== null) {
    const src = path.join(hostUserData, 'conversations')
    const dst = path.join(target, 'conversations')
    try {
      const stat = await fs.stat(src)
      if (stat.isDirectory()) {
        await copyTreeNoOverwrite(src, dst)
      }
    } catch (error) {
      failed.push(`host/conversations: ${error.message || error}`)
    }
  }

  // ── Storage 2: Lima VM /sessions/ tar extract ───────────────────
  if (limaHome !== null) {
    const result = await extractMacSessionsFromVm(target, { env, platform, home, runner, log })
    if (!result.ok) {
      failed.push(`vm/sessions: ${result.message}`)
    }
  }

  // Write migration log (best-effort, never aborts on failure).
  const logFile = path.join(target, MIGRATION_LOG_FILE)
  try {
    const content = [
      `迁移时间: ${new Date().toISOString()}`,
      `平台: darwin`,
      `宿主 userData: ${hostUserData ?? '(未检测到)'}`,
      `Lima VM home: ${limaHome ?? '(未检测到)'}`,
      `迁移目标: ${target}`,
      `失败项 (${failed.length}): ${failed.length > 0 ? failed.join('; ') : '无'}`
    ].join('\n') + '\n'
    await fs.writeFile(logFile, content, 'utf8')
  } catch (error) {
    failed.push(`${MIGRATION_LOG_FILE}: ${error.message || error}`)
  }

  // Mark migration complete (always, even with failures — idempotency).
  try {
    await fs.writeFile(marker, '', 'utf8')
  } catch (error) {
    failed.push(`${MIGRATION_COMPLETED_MARKER}: ${error.message || error}`)
  }

  if (typeof log === 'function') {
    log(`migrate-old-uniwork(mac): ${failed.length} failures`)
  }

  return { migrated: true, target, failed }
}

// ============================================================
// Plan A — unified entry (dispatches by platform)
// ============================================================

/**
 * Plan A unified entry point. Dispatches to the platform-specific migration.
 *
 * @param {string} newAppUserData
 * @param {object} [options]
 * @returns {Promise<{ migrated: boolean, target: string, failed: string[] }>}
 */
export async function migrateOldUniworkData(newAppUserData, { env, platform, log } = {}) {
  env = env || process.env
  platform = platform || process.platform

  if (platform === 'win32') {
    return migrateWinOldUniworkData(newAppUserData, { env, platform, log })
  }
  if (platform === 'darwin') {
    return migrateMacOldUniworkData(newAppUserData, { env, platform, log })
  }
  return { migrated: false, target: '', failed: [] }
}

// ============================================================
// Plan B — account-isolated migration (platform-agnostic)
// ============================================================

/**
 * Plan B: copy Plan A's product (<userData>/old_uniwork_data/) into the
 * current account's workspace (<workspace>/old_uniwork_data/).
 *
 * Behaviour:
 * - Non-win32/darwin → returns { migrated: false } without touching the filesystem.
 * - Awaits `planAPromise` (if provided) so Plan B reads Plan A's complete product.
 * - If Plan A source doesn't exist or lacks the completion marker → skip B.
 * - If Plan B target already has the completion marker → skip B (idempotent per account).
 * - For each subdir in MIGRATE_SUBDIRS:
 *   - If the source subdir doesn't exist in Plan A's product → skip.
 *   - Otherwise copy recursively into the workspace, no-overwrite.
 *   - A single subdir failure is caught and recorded in `failed`; it does not abort.
 * - Writes `migration_log.txt` with run details (best-effort).
 * - Writes `.migration_completed` marker last, even when some subdirs failed.
 *
 * @param {string} newAppUserData - Plan A's parent directory (userData)
 * @param {string} workspaceDir - account workspace directory
 * @param {object} [options]
 * @returns {Promise<{ migrated: boolean, target: string, failed: string[] }>}
 */
export async function migrateOldUniworkToWorkspace(
  newAppUserData,
  workspaceDir,
  { env = process.env, platform = process.platform, planAPromise, log } = {}
) {
  // Platform guard: only win32/darwin.
  if (platform !== 'win32' && platform !== 'darwin') {
    return { migrated: false, target: '', failed: [] }
  }

  // Wait for Plan A to complete (if still running).
  if (planAPromise) {
    try {
      await planAPromise
    } catch {
      // Plan A failure doesn't block B's own judgment below.
    }
  }

  const failed = []

  // Plan A product path.
  const planASource = path.join(newAppUserData, MIGRATION_TARGET_DIR)

  // Judgment 1: Plan A source must exist.
  try {
    await fs.stat(planASource)
  } catch {
    return { migrated: false, target: '', failed: [] }
  }

  // Judgment 2: Plan A must have completed (marker exists).
  const planAMarker = path.join(planASource, MIGRATION_COMPLETED_MARKER)
  try {
    await fs.stat(planAMarker)
  } catch {
    return { migrated: false, target: '', failed: [] }
  }

  // Plan B target path.
  const target = path.join(workspaceDir, MIGRATION_TARGET_DIR)
  await fs.mkdir(target, { recursive: true })

  // Judgment 3: idempotency — has this account already been migrated?
  const marker = path.join(target, MIGRATION_COMPLETED_MARKER)
  try {
    await fs.stat(marker)
    // Older macOS builds may have marked Plan B complete before Plan A could
    // read Lima; resume only directories that Plan A has and this account lacks.
    if (platform !== 'darwin') {
      return { migrated: false, target, failed }
    }
    const hasMissingPlanAData = await Promise.all(MIGRATE_SUBDIRS.map(async subdir => {
      const src = path.join(planASource, subdir)
      const dst = path.join(target, subdir)
      return (await isDirectory(src)) && !(await isDirectory(dst))
    }))
    if (!hasMissingPlanAData.some(Boolean)) {
      return { migrated: false, target, failed }
    }
  } catch {
    // marker doesn't exist — proceed
  }

  // Copy each subdir from Plan A's product → workspace.
  for (const subdir of MIGRATE_SUBDIRS) {
    const src = path.join(planASource, subdir)
    const dst = path.join(target, subdir)

    try {
      const stat = await fs.stat(src)
      if (!stat.isDirectory()) {
        continue
      }
    } catch {
      // Source subdir doesn't exist in Plan A's product — skip.
      continue
    }

    try {
      await copyTreeNoOverwrite(src, dst)
    } catch (error) {
      failed.push(`${subdir}: ${error.message || error}`)
    }
  }

  // Write migration log (best-effort).
  const logFile = path.join(target, MIGRATION_LOG_FILE)
  try {
    const content = [
      `迁移时间: ${new Date().toISOString()}`,
      `平台: ${platform}`,
      `Plan A 源: ${planASource}`,
      `Plan B 目标: ${target}`,
      `迁移子目录: ${MIGRATE_SUBDIRS.join(', ')}`,
      `失败项 (${failed.length}): ${failed.length > 0 ? failed.join('; ') : '无'}`
    ].join('\n') + '\n'
    await fs.writeFile(logFile, content, 'utf8')
  } catch (error) {
    failed.push(`${MIGRATION_LOG_FILE}: ${error.message || error}`)
  }

  // Mark migration complete (always, even with failures — idempotency).
  try {
    await fs.writeFile(marker, '', 'utf8')
  } catch (error) {
    failed.push(`${MIGRATION_COMPLETED_MARKER}: ${error.message || error}`)
  }

  if (typeof log === 'function') {
    log(`migrate-old-uniwork(plan-b): ${failed.length} failures`)
  }

  return { migrated: true, target, failed }
}
