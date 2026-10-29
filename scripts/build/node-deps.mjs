#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { parseArgs } from 'node:util'

// npm.cmd needs a shell. Use npm's JS entrypoint so paths remain argv on Windows.
export function npmCommand({ env = process.env } = {}) {
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm']
  const candidates = [env.npm_execpath]
  for (const dir of (env.PATH || env.Path || '').split(delimiter)) {
    for (const name of names) {
      const bin = join(dir, name)
      if (!existsSync(bin)) continue
      const prefix = dirname(realpathSync(bin))
      const lib = join(prefix, '../lib')
      candidates.push(
        join(prefix, 'node_modules/npm/bin/npm-cli.js'),
        join(prefix, '../lib/node_modules/npm/bin/npm-cli.js'),
        // Nix packages use lib/npm or a versioned lib/npm* directory.
        // Discover the installed JS entrypoint, never parse/execute its shell wrapper.
        ...(existsSync(lib) ? readdirSync(lib).filter(name => name.startsWith('npm')).sort()
          .map(name => join(lib, name, 'bin/npm-cli.js')) : []),
        realpathSync(bin),
      )
    }
  }
  const cli = candidates.find(path => path && path.endsWith('.js') && existsSync(path))
  if (!cli) throw new Error('npm CLI is required on PATH')
  return [process.execPath, cli]
}

// npm's own manifest states its version — no child spawn. A node-under-node spawn
// hits Windows Job-Object EBUSY (#123933), and the probe runs before the reuse
// short-circuit: a read-only version read must not abort an otherwise complete run.
// npm_execpath may point through a symlink; the manifest sits beside the resolved
// CLI, never beside the link. Layouts without a readable manifest return undefined
// so the caller falls back to the child probe, matching the pre-manifest behavior.
function npmManifestVersion(cli) {
  try {
    return JSON.parse(readFileSync(join(dirname(realpathSync(cli)), '..', 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

function completedInstallMatches({ source, receipt, hiddenLock, key, nativeKey }) {
  if (!existsSync(receipt) || !existsSync(hiddenLock)) return false
  const installed = readFileSync(hiddenLock)
  const expected = `${key}\n${createHash('sha256').update(installed).digest('hex')}\n`
  if (nativeKey !== undefined) {
    const nativeReceipt = `${receipt}.native-toolchain`
    if (!existsSync(nativeReceipt) || readFileSync(nativeReceipt, 'utf8') !== `${expected}${nativeKey}\n`) return false
  }
  return readFileSync(receipt, 'utf8') === expected && Object.keys(JSON.parse(installed).packages)
    .every(path => existsSync(join(source, path)))
}

// Electron's postinstall fetches its ~140 MB runtime from github.com, which is
// where a blocked network fails npm ci. npm leaves the dependency tree in place
// when a lifecycle script fails and names only that script's directory in its
// log, so the cause is read from the log rather than guessed from the tree.
const DEFAULT_ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

export function electronMirrorEnv(env) {
  return env.ELECTRON_MIRROR ? env : { ...env, ELECTRON_MIRROR: DEFAULT_ELECTRON_MIRROR }
}

function usesElectron(source, workspaces) {
  return workspaces.some(workspace => {
    const pkg = JSON.parse(readFileSync(join(source, workspace, 'package.json'), 'utf8'))
    return Boolean(pkg.dependencies?.electron ?? pkg.devDependencies?.electron)
  })
}

export function electronPostinstallFailed(npmLog) {
  return /error path .*node_modules[\\/]electron\s*$/m.test(npmLog)
}

// npm retries a failed tarball from byte zero, so a link that drops mid-transfer
// can never finish one large archive. Registry tarballs are cached per package
// and resume across runs that way; lock entries served outside the registry
// (SheetJS publishes only on its own CDN) have no mirror, so they are fetched
// here with ranged resumes and handed to npm's cache under the key npm looks up.
// Registry tarballs all live under a `/-/` path segment.
export function externalLockTarballs(lock) {
  return Object.entries(lock.packages || {}).filter(([, entry]) =>
    /^https:\/\//.test(entry.resolved ?? '') && !entry.resolved.includes('/-/') && entry.integrity)
    .map(([path, entry]) => ({
      name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
      url: entry.resolved,
      integrity: entry.integrity,
    }))
}

// Only tarballs the selected workspaces can reach are prefetched; a Docker or
// ui-tui build must not wait on a desktop-only CDN it never installs.
export function reachablePackageNames(lock, workspaces) {
  const packages = lock.packages || {}
  const names = new Set()
  const queue = workspaces.map(path => packages[path]).filter(Boolean)
  while (queue.length > 0) {
    for (const name of Object.keys(queue.pop().dependencies || {})) {
      if (names.has(name)) continue
      names.add(name)
      if (packages[`node_modules/${name}`]) queue.push(packages[`node_modules/${name}`])
    }
  }
  return names
}

export function downloadWithResume(url, { stallMs = 45000, deadline = Date.now() + 15 * 60 * 1000, maxBytes = 64 << 20 } = {}) {
  const get = url.startsWith('https:') ? httpsGet : httpGet
  return new Promise((resolveDownload, rejectDownload) => {
    const chunks = []
    let received = 0
    let total
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      if (error) rejectDownload(error)
      else resolveDownload(Buffer.concat(chunks))
    }
    const attempt = () => {
      if (settled) return
      if (Date.now() > deadline) return finish(new Error(`gave up on ${url} after ${received} bytes`))
      let done = false
      let request
      // Bytes still buffered from a dropped attempt would shift the resume
      // offset, so the old socket is closed and its events are ignored.
      const retry = () => {
        if (settled || done) return
        done = true
        request?.destroy()
        setTimeout(attempt, 1000)
      }
      request = get(url, received > 0 ? { headers: { range: `bytes=${received}-` } } : {}, response => {
        if (response.statusCode === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] ?? '')
          if (!range || Number(range[1]) !== received) {
            response.resume()
            return finish(new Error(`${url} cannot resume at byte ${received}`))
          }
          total = Number(range[3])
        } else if (response.statusCode === 200) {
          chunks.length = 0
          received = 0
          const length = Number(response.headers['content-length'])
          total = Number.isFinite(length) ? length : undefined
        } else {
          response.resume()
          return finish(new Error(`${url} answered ${response.statusCode}`))
        }
        if (total !== undefined && total > maxBytes) {
          response.resume()
          return finish(new Error(`${url} is ${total} bytes; fetch it with another client`))
        }
        response.on('data', chunk => {
          if (done) return
          chunks.push(chunk)
          received += chunk.length
        })
        response.on('end', () => {
          if (done) return
          if (total === undefined || received >= total) finish()
          else retry()
        })
        response.on('error', retry)
        response.on('aborted', retry)
      })
      request.setTimeout(stallMs, () => request.destroy(new Error('stalled')))
      request.on('error', retry)
    }
    attempt()
  })
}

async function seedExternalTarballs({ source, npm, workspaces }) {
  const lock = JSON.parse(readFileSync(join(source, 'package-lock.json'), 'utf8'))
  const reachable = workspaces.length > 0 ? reachablePackageNames(lock, workspaces) : undefined
  const tarballs = externalLockTarballs(lock).filter(entry => !reachable || reachable.has(entry.name))
  if (tarballs.length === 0) return
  const cache = join(execFileSync(process.execPath, [npm, 'config', 'get', 'cache'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), '_cacache')
  const cacache = createRequire(npm)('cacache')
  for (const { url, integrity } of tarballs) {
    const key = `make-fetch-happen:request-cache:${url}`
    if (await cacache.get.info(cache, key)) continue
    console.log(`node-deps: fetching ${url} with resume (npm restarts it on every retry)...`)
    const body = await downloadWithResume(url)
    const algorithm = integrity.slice(0, integrity.indexOf('-'))
    if (createHash(algorithm).update(body).digest('base64') !== integrity.slice(integrity.indexOf('-') + 1)) {
      throw new Error(`${url} does not match ${integrity}`)
    }
    await cacache.put(cache, key, body, { integrity, metadata: {
      time: Date.now(), url, reqHeaders: {}, options: { compress: true },
      resHeaders: {
        'content-type': 'application/octet-stream',
        'cache-control': 'public, max-age=31536000, immutable',
        date: new Date().toUTCString(),
      },
    } })
  }
}

// The prefetch runs in a child so this entry point stays synchronous for its
// callers; a failure only warns, since npm ci may still reach the tarball.
function seedExternalTarballsBeforeInstall({ node, npm, source, workspaces, env }) {
  let lock
  try {
    lock = JSON.parse(readFileSync(join(source, 'package-lock.json'), 'utf8'))
  } catch {
    return
  }
  const reachable = reachablePackageNames(lock, workspaces)
  if (!externalLockTarballs(lock).some(entry => reachable.has(entry.name))) return
  try {
    execFileSync(node, [fileURLToPath(import.meta.url), '--seed-tarballs', '--source', source, '--npm', npm,
      ...workspaces.flatMap(workspace => ['--workspace', workspace])], { cwd: source, env, stdio: 'inherit' })
  } catch {
    console.warn('node-deps: could not prefetch lockfile tarballs served outside the registry; npm ci will retry them from byte zero')
  }
}

// An interrupted Windows update can leave a nested .bin that npm ci's own rmdir
// cannot clear (ENOTEMPTY, #75584); only deleting node_modules recovers it. npm's
// debug log names the code while stdio stays on the terminal, so give each run
// its own logs dir and retry once only on that code. Other failures keep the tree.
function runNpmCi(node, npm, args, { source, env }) {
  const logsDir = mkdtempSync(join(tmpdir(), 'hermes-npm-logs-'))
  // Builders set CI=1, which turns npm's spinner off. Ask for it back: npm
  // still shows it only on a terminal. Kept out of `args`, which keys the receipt.
  const run = () => execFileSync(node, [npm, ...args, '--progress=true', `--logs-dir=${logsDir}`],
    { cwd: source, env, stdio: 'inherit' })
  const logged = () => readdirSync(logsDir).map(name => readFileSync(join(logsDir, name), 'utf8')).join('\n')
  try {
    run()
  } catch (error) {
    const log = logged()
    if (electronPostinstallFailed(log)) {
      console.error("node-deps: Electron's postinstall could not download its ~140 MB runtime.")
      console.error(`node-deps: It is fetched from ${electronMirrorEnv(env).ELECTRON_MIRROR}; make that URL reachable (ELECTRON_MIRROR overrides it) and run this install again.`)
    }
    if (!log.includes('ENOTEMPTY')) throw error
    console.log('node-deps: npm ci hit ENOTEMPTY; removing node_modules and retrying once...')
    rmSync(join(source, 'node_modules'), { recursive: true, force: true, maxRetries: 3 })
    run()
  } finally {
    rmSync(logsDir, { recursive: true, force: true })
  }
}

/** Install the full requested workspace union in one strict, locked operation. */
export function prepareNodeDependencies({ source, workspaces, env = process.env, reuse = false, install = true, nativeToolchain }) {
  source = resolve(source)
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error('Select at least one workspace; implicit all-workspace installation is not allowed')
  }
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(source, 'package-lock.json'), 'utf8'))
  const workspacePaths = Object.values(lock.packages || {})
    .filter(entry => entry.link)
    .map(entry => entry.resolved)
  const selected = [...new Set(workspaces.map(workspace => {
    const path = workspacePaths.find(path => path === workspace || lock.packages[path]?.name === workspace)
    if (!path || !existsSync(join(source, path, 'package.json'))) {
      throw new Error(`Unknown or missing locked workspace: ${workspace}`)
    }
    return path
  }))].sort()
  const [node, npm] = npmCommand({ env })
  const npmVersion = npmManifestVersion(npm) ?? execFileSync(
    node, [npm, '--version'], { cwd: source, env, encoding: 'utf8' }).trim()
  const { satisfies } = createRequire(npm)('semver')
  for (const [name, version] of [['node', process.versions.node], ['npm', npmVersion]]) {
    const range = manifest.engines?.[name]
    if (range && !satisfies(version, range)) throw new Error(`${name} ${version} violates ${range}`)
  }
  const args = ['ci', '--no-audit', '--no-fund', '--engine-strict', '--include=dev',
    '--include=optional', '--include-workspace-root=true',
    // Registries on slow or unreliable links need more than npm's two retries.
    '--fetch-retries=5', '--fetch-retry-mintimeout=10000', '--fetch-retry-maxtimeout=60000',
    '--fetch-timeout=600000',
    ...selected.flatMap(workspace => ['--workspace', workspace]),
  ]
  // This receipt certifies dependency preparation, never compiled product freshness.
  // Keep it inside the cached tree so a clean npm ci also removes the receipt.
  const receipt = join(source, 'node_modules/.hermes-node-deps')
  // Ordinary product builders consume the baseline receipt; preparation also
  // binds lifecycle outputs to its compiler/SDK identity. On a mismatch npm ci
  // removes arbitrary package lifecycle outputs, not just known node-pty paths.
  const nativeReceipt = `${receipt}.native-toolchain`
  const nativeKey = nativeToolchain === undefined ? undefined : JSON.stringify(nativeToolchain)
  const hiddenLock = join(source, 'node_modules/.package-lock.json')
  const inputs = createHash('sha256').update(JSON.stringify({
    node: process.versions.node, npm: npmVersion, platform: process.platform, arch: process.arch, args,
    // npm names are case-insensitive; Windows Python uppercases inherited keys.
    config: Object.entries(env).filter(([key]) => /^npm_config_/i.test(key) && !/^npm_config_(cache|offline|prefer_offline)$/i.test(key))
      .map(([key, value]) => [key.toLowerCase(), value]).sort(),
  }))
  const files = ['package-lock.json', '.npmrc', ...Object.keys(lock.packages)
    .filter(path => !path.split('/').includes('node_modules'))
    .map(path => join(path, 'package.json'))].sort()
  for (const file of files) {
    inputs.update(file).update('\0').update(existsSync(join(source, file)) ? readFileSync(join(source, file)) : '<missing>').update('\0')
  }
  const key = inputs.digest('hex')
  if (reuse && completedInstallMatches({ source, receipt, hiddenLock, key, nativeKey })) {
    console.log(`node-deps: reusing completed install (${selected.join(', ')})`)
    return { source, workspaces: selected }
  }
  if (!install) throw new Error('Workspace dependencies are stale or missing and lazy installs are disabled; run an explicit build/update')
  // npm can fail during validation before deleting node_modules. Invalidate first.
  rmSync(receipt, { force: true })
  rmSync(nativeReceipt, { force: true })
  console.log(`node-deps: installing workspace dependencies with npm ci (${selected.join(', ')})...`)
  const installEnv = electronMirrorEnv(env)
  if (installEnv !== env && usesElectron(source, selected)) {
    console.log(`node-deps: Electron downloads use ${DEFAULT_ELECTRON_MIRROR} (set ELECTRON_MIRROR to override)`)
  }
  seedExternalTarballsBeforeInstall({ node, npm, source, workspaces: selected, env: installEnv })
  runNpmCi(node, npm, args, { source, env: installEnv })
  if (reuse) {
    const completed = `${key}\n${createHash('sha256').update(readFileSync(hiddenLock)).digest('hex')}\n`
    writeFileSync(receipt, completed)
    if (nativeKey !== undefined) writeFileSync(nativeReceipt, `${completed}${nativeKey}\n`)
  }
  return { source, workspaces: selected }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // The Python bundle driver uses this same resolver, not a second layout probe.
  if (process.argv[2] === '--npm') {
    const [node, ...command] = npmCommand()
    const child = spawnSync(node, [...command, ...process.argv.slice(3)], { stdio: 'inherit' })
    if (child.error) throw child.error
    process.exit(child.status ?? 1)
  }
  const { values } = parseArgs({ options: {
    source: { type: 'string' }, workspace: { type: 'string', multiple: true },
    reuse: { type: 'boolean', default: false },
    'no-install': { type: 'boolean', default: false },
    'native-toolchain': { type: 'string' },
    'seed-tarballs': { type: 'boolean', default: false },
    npm: { type: 'string' },
  } })
  if (!values.source) throw new Error('--source is required')
  if (values['seed-tarballs']) {
    await seedExternalTarballs({ source: resolve(values.source), npm: values.npm ?? npmCommand()[1], workspaces: values.workspace ?? [] })
  } else {
    prepareNodeDependencies({ source: values.source, workspaces: values.workspace, reuse: values.reuse, install: !values['no-install'], nativeToolchain: values['native-toolchain'] })
  }
}
