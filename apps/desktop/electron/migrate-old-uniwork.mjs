// migrate-old-uniwork.mjs — pure Node migration core for legacy UniWork
// userData. No Electron imports; only node:fs and node:path. The app imports
// this through migrate-old-uniwork.ts (a typed re-export), and tests import
// the .mjs directly because Node's type-stripping cannot resolve extensionless
// TypeScript imports.

import { promises as fs } from 'node:fs'
import path from 'node:path'

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

/**
 * Resolve the legacy UniWork app userData directory.
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

/**
 * Migrate legacy UniWork userData subdirectories into the new app userData
 * under `old_uniwork_data/`. Windows-only; no-op elsewhere.
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
export async function migrateOldUniworkData(newAppUserData, { env, platform, log } = {}) {
  env = env || process.env
  platform = platform || process.platform
  const failed = []

  // Platform guard: only Windows.
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
    log(`migrate-old-uniwork: migrated ${MIGRATE_SUBDIRS.length} subdirs, ${failed.length} failures`)
  }

  return { migrated: true, target, failed }
}
