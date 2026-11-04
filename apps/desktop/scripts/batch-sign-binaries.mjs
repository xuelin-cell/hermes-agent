// batch-sign-binaries.mjs — Authenticode-sign every standalone binary inside
// the packed Windows app tree (Hermes.exe's sibling DLLs and everything under
// resources/agent-payload/tools/: node.exe, ffmpeg.exe, chromium, the minted
// CLI launcher exes, pm tool binaries, …).
//
// Why a batch: Windows validates only the MSIX package signature
// (AppxSignature.p7x over AppxBlockMap.xml), so inner binaries have never been
// signed. But an MSIX whose payload carries unsigned PEs trips SmartScreen /
// enterprise WDAC policies that scan inner files, and signature-verification
// tooling reports the app as mixed signed/unsigned. Task 0 (pm-clean fix
// plan): sign the whole tree, once, in chunked signtool invocations.
//
// Ordering (electron-builder win32 pipeline, pinned by app-builder-lib source):
//   beforePack → pack → afterPack (this module's caller) → electron fuses
//   → signAndEditResources (rcedit on the product exe) → per-file sign hook.
// Consequences:
//   - The batch runs in afterPack AFTER sanitize-pe-signatures.mjs (a dangling
//     certificate table makes signtool fail 0x800700C1) and AFTER the rcedit
//     identity stamp, so neither can invalidate what we sign.
//   - The product exe (`<productName>.exe`) is EXCLUDED from the batch:
//     rcedit edits its resources (and the electron fuses flip) after
//     afterPack, which invalidates any signature. It is signed per-file by the
//     customSign hook AFTER rcedit, on the exact Azure mechanism sign-msix.mjs
//     uses for the package itself.
//   - Extra-resource copies invoke customSign BEFORE afterPack; payload files
//     are deferred to the sanitized batch. Later per-file calls are no-ops,
//     so electron-builder never re-signs those binaries one-by-one.
//
// Sign-nested-chromium.mjs stays as-is: it is macOS-only (codesign --deep over
// .app bundles inside the payload for Apple notarization) and is invoked from
// the darwin branch of after-pack.mjs. There is no overlap with this Windows
// Authenticode batch.
//
// Gating matches the rest of the pipeline: this module only signs when the
// Azure Trusted Signing variables are present (the same AZURE_SIGN_* set the
// release-signing workflow arms provide). Without them — local builds, forks,
// unsigned canary lanes — it is a no-op with a loud warning, exactly like
// stage-msixbundle.mjs. The shared Windows tool provisioner supplies the
// matching SDK, ATS dlib, and .NET runtime even when the cache is empty.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Arch } from 'app-builder-lib'
import { computeArchToTargetNamesMap } from 'app-builder-lib/internal'
import { isMain } from './utils.mjs'
import { createPayloadSignCache } from './payload-sign-cache.mjs'
import { ensureWindowsBundleTools } from './windows-bundle-tools.mjs'
import { resolveSigningMode, resolveSigner, buildSignArgs } from './resolve-windows-signer.mjs'

/** @typedef {(cmd: string, args: string[], options?: import('node:child_process').ExecFileOptions) => unknown} SignExecutor */

export const CHUNK_SIZE = 100
// How many signtool children may run at once. Azure Trusted Signing and the
// timestamp server are both network round-trips per file, so N concurrent
// children multiply throughput ~Nx. Keep it modest — the timestamp server
// rate-limits aggressive bursters.
export const DEFAULT_CONCURRENCY = 4
// Separate timestamp pass URL. `timestamp.acs.microsoft.com` intermittently
// fails with "Invalid Time Stamp Request Length:-1" (documented widely);
// digicert's RFC3161 endpoint has been reliable in the release pipeline.
const TIMESTAMP_URL = 'http://timestamp.digicert.com'
// Multiple timestamp servers for failover. UKey/local signing benefits from
// trying several servers when one is flaky.
const TIMESTAMP_SERVERS = [
  'http://timestamp.digicert.com',
  'http://timestamp.sectigo.com',
  'http://timestamp.globalsign.com/tsa/r6advanced1',
  'http://tsa.starfieldtech.com',
]
// Maximum command line length for signtool batch (CreateProcess limit ~32K).
// Leave headroom for the signtool path and other args.
const MAX_CMDLINE_CHARS = 28000

/**
 * execFile as a promise, so chunks can run concurrently.
 * @returns {Promise<void>} rejects with the child's error on non-zero exit.
 */
function execFileAsync(cmd, args, options) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/**
 * Retry a fallible op (bounded). Used for the timestamp pass, where the
 * external server flakes intermittently — a retried timestamp beats a whole
 * rebuild. Exponential backoff (1s, 2s, ...) between attempts.
 *
 * @param {() => Promise<void>} fn
 * @param {{ attempts?: number, baseDelayMs?: number }} [opts]
 */
export async function withRetry(fn, opts = {}) {
  const attempts = opts.attempts ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 1000
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt))
      }
    }
  }
  throw lastError
}

/**
 * Run up to `concurrency` async workers over items. Each worker pulls the
 * next item as it frees up, so unevenly-sized work balances itself.
 *
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} worker
 * @template T
 */
export async function runPool(items, concurrency, worker) {
  let index = 0
  const next = async () => {
    while (index < items.length) {
      const i = index
      index += 1
      await worker(items[i], i)
    }
  }
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    () => next()
  )
  await Promise.all(workers)
}

/**
 * Recursively collect every .exe/.dll under dir. Symbolic links are skipped
 * (the payload's materialized-link layout can contain them; the target is
 * collected on its own walk). Sorted for deterministic chunking.
 *
 * @param {string} dir
 * @param {{ skip?: (file: string) => boolean }} [opts]
 * @returns {string[]}
 */
export function getBinaries(dir, opts = {}) {
  const out = []
  const walk = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      if (lower.endsWith('.exe') || lower.endsWith('.dll')) {
        if (opts.skip && opts.skip(full)) continue
        out.push(full)
      }
    }
  }
  walk(dir)
  return out.sort()
}

/** Split a file list into signtool-sized batches. */
export function chunk(items, size = CHUNK_SIZE) {
  const chunks = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/** True when the Azure Trusted Signing variables are all present. */
export function azureSigningConfigured(env = process.env) {
  return Boolean(env.AZURE_SIGN_ENDPOINT && env.AZURE_SIGN_ACCOUNT && env.AZURE_SIGN_PROFILE)
}

/**
 * Determine signing mode from environment.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {'azure' | 'ukey' | 'pfx' | 'none'}
 */
export function signingMode(env = process.env) {
  return resolveSigningMode(env)
}

/**
 * Chunk files by character budget instead of fixed count.
 * UKey signing prompts per invocation, so minimizing chunks = minimizing PIN prompts.
 * @param {string[]} files
 * @param {number} [maxChars=MAX_CMDLINE_CHARS]
 * @returns {string[][]}
 */
export function chunkByCharBudget(files, maxChars = MAX_CMDLINE_CHARS) {
  const chunks = []
  let current = []
  let currentLen = 0
  for (const file of files) {
    const fileLen = file.length + 3 // quotes + space
    if (currentLen + fileLen > maxChars && current.length > 0) {
      chunks.push(current)
      current = []
      currentLen = 0
    }
    current.push(file)
    currentLen += fileLen
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * Sign one chunk of binaries with a single signtool invocation (argv array,
 * never a shell string — the joined list can be long and must not interpolate
 * through a shell).
 *
 * For Azure: NO timestamp here (see timestampChunk — the sign pass would
 * otherwise hold each file hostage to the flaky timestamp server).
 * For local cert (UKey/PFX): timestamp is included in the same pass.
 *
 * @param {string[]} files
 * @param {{ signtool: string, mode: 'azure' | 'ukey' | 'pfx', dlib?: string, metadataPath?: string, certificate?: import('./resolve-windows-signer.mjs').CertificateConfig, timestampUrl?: string, description?: string, descriptionUrl?: string, exec?: SignExecutor, execOptions?: import('node:child_process').ExecFileOptions }} opts
 */
export async function signChunk(files, opts) {
  let args

  if (opts.mode === 'azure') {
    // Azure Trusted Signing path
    args = [
      'sign',
      '/fd', 'SHA256',
      '/dlib', opts.dlib,
      '/dmdf', opts.metadataPath,
      ...files
    ]
  } else {
    // Local certificate path (UKey or PFX)
    const signer = {
      mode: opts.mode,
      signtool: opts.signtool,
      certificate: opts.certificate,
    }
    args = buildSignArgs(signer, files, {
      timestampUrl: opts.timestampUrl ?? TIMESTAMP_URL,
      description: opts.description,
      descriptionUrl: opts.descriptionUrl,
    })
  }

  if (opts.exec) {
    await opts.exec(opts.signtool, args, opts.execOptions)
    return
  }
  await execFileAsync(opts.signtool, args, opts.execOptions ?? { stdio: 'inherit' })
}

/**
 * RFC3161-timestamp one chunk of ALREADY-SIGNED files. No /dlib, no /dmdf —
 * this is pure timestamping, so it neither re-auths against Azure nor
 * re-initializes the .NET dlib. The timestamp server is the flaky external
 * dependency, so this pass retries per chunk with failover across multiple
 * servers (a retried timestamp beats a whole re-sign) and runs concurrently
 * like the sign pass.
 *
 * @param {string[]} files
 * @param {{ signtool: string, timestampUrl?: string, timestampServers?: string[], exec?: SignExecutor, execOptions?: import('node:child_process').ExecFileOptions, timestampAttempts?: number, timestampRetryDelayMs?: number }} opts
 */
export async function timestampChunk(files, opts) {
  const servers = opts.timestampServers ?? (opts.timestampUrl ? [opts.timestampUrl] : TIMESTAMP_SERVERS)
  let lastError

  for (const server of servers) {
    const args = [
      'timestamp',
      '/tr', server,
      '/td', 'SHA256',
      ...files
    ]
    const run = async () => {
      if (opts.exec) {
        await opts.exec(opts.signtool, args, opts.execOptions)
        return
      }
      await execFileAsync(opts.signtool, args, opts.execOptions ?? { stdio: 'inherit' })
    }
    try {
      await withRetry(run, {
        attempts: opts.timestampAttempts,
        baseDelayMs: opts.timestampRetryDelayMs
      })
      return // Success, no need to try other servers
    } catch (error) {
      lastError = error
      console.warn(`[batch-sign] timestamp server ${server} failed, trying next...`)
    }
  }

  throw lastError ?? new Error('All timestamp servers failed')
}

/**
 * Batch-sign every binary under a tree.
 *
 * For Azure: Two passes: (1) Azure Authenticode sign — concurrent signtool
 * children, no timestamp; (2) RFC3161 timestamp — concurrent, no Azure/dlib,
 * retried. A verified content cache removes unchanged inputs from both passes.
 *
 * For local cert (UKey/PFX): Single pass with timestamp included. UKey mode
 * forces concurrency=1 (hardware token can't sign in parallel) and uses
 * character-budget chunking to minimize PIN prompts.
 *
 * @param {string[]} binaries file list from getBinaries
 * @param {{ env?: NodeJS.ProcessEnv, exec?: SignExecutor, chunkSize?: number, concurrency?: number, mkdtemp?: typeof fs.mkdtempSync, signtool?: string, dlib?: string, dotnetRoot?: string, config?: import('app-builder-lib').Configuration, resourcesDir?: string, timestampUrl?: string, timestampServers?: string[], timestampAttempts?: number, timestampRetryDelayMs?: number, cache?: ReturnType<typeof createPayloadSignCache>, description?: string, descriptionUrl?: string }} [opts]
 * @returns {Promise<{ signed: number, chunks: number, skipped: boolean, mode: string }>}
 *   skipped=true when signing is not configured (caller warns).
 */
export async function batchSignBinaries(binaries, opts = {}) {
  const env = opts.env ?? process.env
  const mode = signingMode(env)

  if (mode === 'none') {
    return { signed: 0, chunks: 0, skipped: true, mode }
  }

  if (binaries.length === 0) {
    return { signed: 0, chunks: 0, skipped: false, mode }
  }

  // Resolve signer configuration for local cert modes
  let signer = null
  if (mode === 'ukey' || mode === 'pfx') {
    signer = await resolveSigner({ signing: true, env })
  }

  // afterPack runs before the per-file Azure signer downloads its tools.
  // For Azure, we need dlib; for local cert, we only need signtool.
  const needsDlib = mode === 'azure'
  let signtool, dlib = null, dotnetRoot = null

  if (opts.signtool) {
    signtool = opts.signtool
    dlib = opts.dlib
    dotnetRoot = opts.dotnetRoot
  } else {
    const tools = await ensureWindowsBundleTools({
      signing: needsDlib,
      config: opts.config,
      resourcesDir: opts.resourcesDir
    })
    signtool = tools.signtool
    dlib = tools.dlib
    dotnetRoot = tools.dotnetRoot
  }

  const started = performance.now()

  // Cache is only used for Azure mode (local cert signing is fast enough)
  const cache = mode === 'azure' && opts.cache === undefined ? createPayloadSignCache({
    root: env.ELECTRON_BUILDER_CACHE ? `${env.ELECTRON_BUILDER_CACHE}-payload-signatures` : null,
    env, signtool, dlib, timestampUrl: opts.timestampUrl ?? TIMESTAMP_URL
  }) : opts.cache

  const plan = cache ? await cache.prepare(binaries) : null
  const toSign = plan?.files ?? binaries
  console.log(`[batch-sign] mode=${mode}, ${plan?.restored ?? 0} cache hits, ${toSign.length} to sign, ${plan?.duplicates ?? 0} duplicate copies`)

  // Build environment for signtool
  const signEnv = { ...env }
  if (dotnetRoot) signEnv.DOTNET_ROOT = dotnetRoot

  // For Azure mode, create metadata file
  let tmpDir = null
  let metadataPath = null
  if (mode === 'azure') {
    const mkdtemp = opts.mkdtemp ?? fs.mkdtempSync
    tmpDir = mkdtemp(path.join(env.TEMP || env.TMP || '.', 'batch-sign-'))
    metadataPath = path.join(tmpDir, 'batch-sign.json')
    fs.writeFileSync(metadataPath, JSON.stringify({
      Endpoint: env.AZURE_SIGN_ENDPOINT,
      CodeSigningAccountName: env.AZURE_SIGN_ACCOUNT,
      CertificateProfileName: env.AZURE_SIGN_PROFILE
    }))
  }

  // Determine concurrency and chunking strategy
  // UKey: serial (hardware token can't parallelize), character-budget chunks
  // Azure/PFX: concurrent, fixed-size chunks
  const isUKey = mode === 'ukey'
  const concurrency = isUKey ? 1 : (opts.concurrency ?? DEFAULT_CONCURRENCY)
  const batches = isUKey
    ? chunkByCharBudget(toSign)
    : chunk(toSign, opts.chunkSize ?? CHUNK_SIZE)

  const execOptions = { stdio: 'inherit', env: signEnv }

  try {
    if (mode === 'azure') {
      // Pass 1: Azure Authenticode sign — concurrent, no timestamp.
      await runPool(batches, concurrency, (batch) =>
        signChunk(batch, { signtool, mode, dlib, metadataPath, exec: opts.exec, execOptions })
      )
      // Pass 2: RFC3161 timestamp — concurrent, no Azure/dlib, retried with failover.
      await runPool(batches, concurrency, (batch) =>
        timestampChunk(batch, {
          signtool,
          timestampUrl: opts.timestampUrl,
          timestampServers: opts.timestampServers,
          exec: opts.exec,
          execOptions,
          timestampAttempts: opts.timestampAttempts,
          timestampRetryDelayMs: opts.timestampRetryDelayMs
        })
      )
    } else {
      // Local cert (UKey/PFX): single pass with timestamp included
      await runPool(batches, concurrency, (batch) =>
        signChunk(batch, {
          signtool,
          mode,
          certificate: signer?.certificate,
          timestampUrl: opts.timestampUrl,
          description: opts.description,
          descriptionUrl: opts.descriptionUrl,
          exec: opts.exec,
          execOptions
        })
      )
    }

    if (cache) await cache.publish(plan)
    console.log(`[batch-sign] completed in ${((performance.now() - started) / 1000).toFixed(1)}s`)
    return { signed: toSign.length, chunks: batches.length, skipped: false, mode }
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * afterPack-side entry: batch-sign the packed tree, excluding the product exe
 * (it is rcedit-ed and signed per-file after this hook — see the header).
 * Callers must have run sanitize-pe-signatures.mjs first.
 *
 * @param {string} appOutDir
 * @param {string} productExePath absolute path of the main product exe
 * @param {Parameters<typeof batchSignBinaries>[1]} [opts]
 */
export async function batchSignAppTree(appOutDir, productExePath, opts = {}) {
  const env = opts.env ?? process.env
  const mode = signingMode(env)

  if (mode === 'none') {
    console.warn(
      '[batch-sign] No signing configured — payload binaries will be UNSIGNED ' +
      '(package block-map still covers them; release lanes must set HERMES_SIGNING_MODE=release)'
    )
    return { signed: 0, chunks: 0, skipped: true, mode }
  }

  const productExe = productExePath ? path.resolve(productExePath) : null
  // uv-cache/ is the pm bundle's deliberately-shipped build cache (inert
  // sdist/archive artifacts, never loaded at runtime — the arch audit
  // exempts it for the same reason). Signing it wastes Azure round-trips
  // on dead weight and can FAIL: locally the cache may hold files that
  // were removed between pm bundle staging and the afterPack walk.
  const inCache = (file) => /(^|[\\/])uv-cache[\\/]/.test(path.resolve(file))
  const binaries = getBinaries(appOutDir, {
    skip: (file) =>
      inCache(file) || (productExe ? path.resolve(file) === productExe : false)
  })
  if (binaries.length === 0) return { signed: 0, chunks: 0, skipped: false, mode }
  const result = await batchSignBinaries(binaries, opts)
  console.log(
    `[batch-sign] signed ${result.signed} payload binaries in ${result.chunks} signtool batch(es) (mode=${result.mode})` +
    ` (product exe excluded — signed per-file after rcedit)`
  )
  return result
}

// ── electron-builder custom win.sign hook ───────────────────────────────────
//
// Per app-builder-lib's signtoolBaseSignManager, the custom `sign` hook is
// invoked once per signable file (the product exe after rcedit, top-level
// exes, asar.unpacked natives, extraResource exes). The hook's return value is
// ignored by the manager, but per the Task 0 contract it resolves true for
// files the afterPack batch already signed — a no-op — and delegates the two
// artifacts that genuinely need per-file signing to the sign-msix.mjs Azure
// machinery: the .msix/.msixbundle package and the product exe.

const SIGNABLE_PACKAGE_EXTENSIONS = ['.msix', '.msixbundle']
const STORE_ARTIFACT_PREFIX = 'Store-'
const NSIS_UNINSTALLER_PREFIX = '__uninstaller-nsis-'

/**
 * Match the paths WinPackager.signApp signs after editing the root executable.
 * The per-file hook has no arch/appOutDir: use the same target normalization,
 * output macros and computeAppOutDir as Packager.doBuild/PlatformPackager.pack.
 * @param {string} file
 * @param {import('app-builder-lib').WinPackager} packager
 * @returns {boolean}
 */
function isProductExe(file, packager) {
  // Packager initializes targets and validateConfig supplies directories.output
  // before doBuild can invoke this hook (the public input types are optional).
  const targets = /** @type {Map<Arch, string[]>} */ (packager.packagerOptions.targets?.get(packager.platform))
  const output = /** @type {string} */ (packager.config.directories?.output)
  const arches = computeArchToTargetNamesMap(targets, packager, packager.platform)
  const resolved = path.resolve(file).toLowerCase()
  for (const arch of arches.keys()) {
    const outDir = path.resolve(packager.projectDir, packager.expandMacro(output, Arch[arch]))
    // Protected in the declarations, but this is the actual pack() resolver;
    // bracket access avoids inventing a parallel output-directory convention.
    const appOutDir = packager['computeAppOutDir'](outDir, arch)
    const productExe = path.resolve(appOutDir, `${packager.appInfo.productFilename}.exe`)
    if (resolved === productExe.toLowerCase()) return true
  }
  return false
}

/**
 * Check if a file is an NSIS uninstaller (must be signed immediately, not deferred).
 * @param {string} file
 * @returns {boolean}
 */
function isNsisUninstaller(file) {
  return path.basename(file).toLowerCase().startsWith(NSIS_UNINSTALLER_PREFIX)
}

/**
 * Check if a file is the NSIS installer (must be signed immediately).
 * @param {string} file
 * @param {import('app-builder-lib').WinPackager} packager
 * @returns {boolean}
 */
function isNsisInstaller(file, packager) {
  const base = path.basename(file).toLowerCase()
  // Installer is typically <productName>-<version>.exe in the dist directory
  // or matches the artifactName pattern
  const artifactName = packager.expandMacro(packager.config.artifactName || '${productName} Setup ${version}.${ext}')
  const expectedInstaller = artifactName.toLowerCase().replace(/\$\{[^}]+\}/g, (match) => {
    if (match.includes('productName')) return packager.appInfo.productFilename.toLowerCase()
    if (match.includes('version')) return packager.appInfo.version.toLowerCase()
    if (match.includes('ext')) return 'exe'
    return match
  })
  return base === expectedInstaller || base.endsWith('-win-x64.exe') || base.endsWith('-win.exe')
}

/**
 * Sign a single file with local certificate (UKey/PFX).
 * Used for installer, uninstaller, and product exe which can't go through batch.
 * @param {string} file
 * @param {import('./resolve-windows-signer.mjs').SignerConfig} signer
 * @param {object} [opts]
 * @param {string} [opts.timestampUrl]
 * @param {string} [opts.description]
 * @param {string} [opts.descriptionUrl]
 */
async function signSingleFile(file, signer, opts = {}) {
  const args = buildSignArgs(signer, [file], {
    timestampUrl: opts.timestampUrl ?? TIMESTAMP_URL,
    description: opts.description,
    descriptionUrl: opts.descriptionUrl,
  })
  await execFileAsync(signer.signtool, args, { stdio: 'inherit' })
}

/**
 * The electron-builder custom win.sign hook.
 *
 * @param {{ path: string }} configuration
 * @param {import('app-builder-lib').WinPackager} packager
 * @param {{ signMsix?: (configuration: { path: string }, packager: import('app-builder-lib').WinPackager) => Promise<void>, azureSignFile?: (file: string, packager: import('app-builder-lib').WinPackager) => Promise<void> }} [deps]
 * @returns {Promise<boolean>} true when this hook handled the file
 *   (batch-signed: nothing to do) — electron-builder must not re-sign it.
 */
export async function customSign(configuration, packager, deps = {}) {
  const file = configuration.path
  const base = path.basename(file)
  const env = process.env
  const mode = signingMode(env)

  // Store-submission packages are Partner Center's to sign (see sign-msix.mjs).
  if (base.startsWith(STORE_ARTIFACT_PREFIX)) return true

  const lower = file.toLowerCase()
  if (SIGNABLE_PACKAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) {
    // MSIX signing only works with Azure currently
    if (mode === 'azure') {
      const { default: signMsix } = await import('./sign-msix.mjs')
      await (deps.signMsix ?? signMsix)(configuration, packager)
    } else if (mode !== 'none') {
      console.warn(`[customSign] MSIX signing not supported in ${mode} mode, skipping: ${file}`)
    }
    return true
  }

  // The product exe was rcedit-ed after the batch ran, so it is signed here,
  // after its resources are final.
  const productName = packager.appInfo.productFilename
  if (base.toLowerCase() === `${productName.toLowerCase()}.exe` && isProductExe(file, packager)) {
    if (mode === 'azure') {
      const { azureSignFile } = await import('./sign-msix.mjs')
      await (deps.azureSignFile ?? azureSignFile)(file, packager)
    } else if (mode === 'ukey' || mode === 'pfx') {
      // Local cert: sign immediately with the resolved signer
      const signer = await resolveSigner({ signing: true, env })
      await signSingleFile(file, signer, {
        description: productName,
        descriptionUrl: env.HERMES_PRODUCT_URL,
      })
    }
    return true
  }

  // NSIS uninstaller: must be signed immediately (it gets deleted after this hook)
  if (isNsisUninstaller(file)) {
    if (mode === 'ukey' || mode === 'pfx') {
      const signer = await resolveSigner({ signing: true, env })
      await signSingleFile(file, signer)
    } else if (mode === 'azure') {
      // Azure mode: use the same per-file signing as product exe
      const { azureSignFile } = await import('./sign-msix.mjs')
      await (deps.azureSignFile ?? azureSignFile)(file, packager)
    }
    return true
  }

  // NSIS installer: must be signed immediately (otherwise blockmap/feed yml become stale)
  if (isNsisInstaller(file, packager)) {
    if (mode === 'ukey' || mode === 'pfx') {
      const signer = await resolveSigner({ signing: true, env })
      await signSingleFile(file, signer, {
        description: productName,
        descriptionUrl: env.HERMES_PRODUCT_URL,
      })
    } else if (mode === 'azure') {
      const { azureSignFile } = await import('./sign-msix.mjs')
      await (deps.azureSignFile ?? azureSignFile)(file, packager)
    }
    return true
  }

  // Payload copies arrive before afterPack; defer them to its sanitized batch.
  // Calls after afterPack are no-ops for binaries that batch already signed.
  return true
}

async function main() {
  const root = process.argv[2]
  if (!root) {
    console.error('usage: batch-sign-binaries.mjs <dir>')
    process.exit(2)
  }
  const result = await batchSignAppTree(root, process.env.HERMES_PRODUCT_EXE || path.join(root, 'Hermes.exe'))
  if (result.skipped) process.exit(0)
}

if (isMain(import.meta.url)) {
  main()
}

// electron-builder's resolveFunction prefers a named export matching the hook
// name ("sign") and falls back to the module default — provide both so the
// config's `sign: './scripts/batch-sign-binaries.mjs'` binds to customSign.
export { customSign as sign }
export default customSign
