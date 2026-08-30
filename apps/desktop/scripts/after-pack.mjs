/** Package the Windows identity and a self-contained local backend. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stampExeIdentity } from './set-exe-identity.mjs'

function findBundledUvCandidate() {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'hermes', 'bin', 'uv.exe') : null,
    path.join(os.homedir(), '.local', 'bin', 'uv.exe')
  ].filter(Boolean)
  return candidates.find(candidate => fs.existsSync(candidate)) || null
}

function stageWindowsBootstrapTools(appOutDir) {
  const uv = findBundledUvCandidate()
  if (!uv) throw new Error('[after-pack] uv.exe is required for a self-contained Windows build')
  const destination = path.join(appOutDir, 'resources', 'bootstrap-tools', 'uv.exe')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(uv, destination)
  console.log(`[after-pack] staged bootstrap uv.exe: ${uv} -> ${destination}`)
  return destination
}

function stageWindowsBootstrapInstaller(appOutDir, desktopRoot) {
  const source = path.resolve(desktopRoot, '..', '..', 'scripts', 'install.ps1')
  if (!fs.existsSync(source)) throw new Error(`[after-pack] Windows bootstrap installer not found: ${source}`)
  const destination = path.join(appOutDir, 'resources', 'bootstrap-source', 'scripts', 'install.ps1')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
  return destination
}

function stageWindowsBootstrapRepository(appOutDir, desktopRoot) {
  const repositoryRoot = path.resolve(desktopRoot, '..', '..')
  const destination = path.join(appOutDir, 'resources', 'bootstrap-source', 'hermes-agent')
  const archive = path.join(os.tmpdir(), `hermes-agent-${process.pid}.tar`)
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(destination, { recursive: true })
  execFileSync('git', ['archive', '--format=tar', '-o', archive, 'HEAD'], { cwd: repositoryRoot, stdio: 'pipe', windowsHide: true })
  try {
    execFileSync('tar', ['-xf', archive, '-C', destination], { stdio: 'pipe', windowsHide: true })
  } finally {
    fs.rmSync(archive, { force: true })
  }
  console.log(`[after-pack] staged self-contained Hermes source: ${destination}`)
  return destination
}

function runtimeCacheKey(repositoryRoot) {
  const hash = createHash('sha256')
  for (const name of ['uv.lock', 'pyproject.toml']) hash.update(fs.readFileSync(path.join(repositoryRoot, name)))
  hash.update('cpython-3.11-windows-x86_64-none-relocatable-v2')
  return hash.digest('hex').slice(0, 16)
}

function prepareWindowsPythonRuntime(desktopRoot) {
  const repositoryRoot = path.resolve(desktopRoot, '..', '..')
  const uv = findBundledUvCandidate()
  if (!uv) throw new Error('[after-pack] uv.exe is required to build the Python runtime')
  const cacheRoot = process.env.HERMES_DESKTOP_RUNTIME_CACHE || path.join(desktopRoot, '.runtime-cache')
  const key = runtimeCacheKey(repositoryRoot)
  const cacheDir = path.join(cacheRoot, 'win32-x64', key)
  const pythonInstalls = path.join(cacheDir, 'python-installs')
  const venv = path.join(cacheDir, 'venv')
  const ready = path.join(cacheDir, 'ready.json')
  const cachedPython = fs.existsSync(pythonInstalls) && fs.readdirSync(pythonInstalls).some(name => /^cpython-3\.11\.\d+-windows-x86_64-none$/.test(name))
  const cachedVenv = fs.existsSync(path.join(venv, 'Scripts', 'python.exe'))

  if (!fs.existsSync(ready) && !(cachedPython && cachedVenv)) {
    fs.rmSync(cacheDir, { recursive: true, force: true })
    fs.mkdirSync(cacheDir, { recursive: true })
    const env = { ...process.env, UV_CACHE_DIR: path.join(cacheRoot, 'uv-download-cache'), UV_PYTHON_INSTALL_DIR: pythonInstalls,
      UV_PROJECT_ENVIRONMENT: venv, UV_PYTHON: '3.11' }
    console.log(`[after-pack] building cached self-contained Python runtime: ${cacheDir}`)
    execFileSync(uv, ['python', 'install', '3.11'], { env, stdio: 'inherit', windowsHide: true })
    execFileSync(uv, ['venv', '--python', '3.11', '--relocatable', '--link-mode', 'copy', venv], { env, stdio: 'inherit', windowsHide: true })
    execFileSync(uv, ['sync', '--extra', 'all', '--locked', '--active'], {
      cwd: repositoryRoot, env: { ...env, VIRTUAL_ENV: venv }, stdio: 'inherit', windowsHide: true
    })
  }
  if (!fs.existsSync(ready)) {
    execFileSync(path.join(venv, 'Scripts', 'python.exe'), ['-c', 'import hermes_cli, dotenv, yaml, uvicorn'], {
      cwd: cacheDir, env: { ...process.env, PYTHONPATH: repositoryRoot }, stdio: 'inherit', windowsHide: true
    })
    fs.writeFileSync(ready, JSON.stringify({ key, createdAt: new Date().toISOString() }))
  } else {
    console.log(`[after-pack] reusing cached self-contained Python runtime: ${cacheDir}`)
  }
  const pythonDirs = fs.readdirSync(pythonInstalls, { withFileTypes: true }).filter(
    entry => entry.isDirectory() && /^cpython-3\.11\.\d+-windows-x86_64-none$/.test(entry.name)
  )
  if (pythonDirs.length !== 1) throw new Error(`[after-pack] expected one cached Python runtime in ${pythonInstalls}`)
  return { base: path.join(pythonInstalls, pythonDirs[0].name), venv }
}

function stageWindowsPythonRuntime(appOutDir, desktopRoot) {
  const runtime = prepareWindowsPythonRuntime(desktopRoot)
  const destination = path.join(appOutDir, 'resources', 'python-runtime')
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(destination, { recursive: true })
  fs.cpSync(runtime.base, path.join(destination, 'base'), { recursive: true })
  fs.cpSync(runtime.venv, path.join(destination, 'venv'), { recursive: true })
  fs.writeFileSync(path.join(destination, 'build-source-root.txt'), path.resolve(desktopRoot, '..', '..'))
  console.log(`[after-pack] staged cached Python runtime and dependencies: ${destination}`)
  return destination
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const productName = context.packager?.appInfo?.productFilename || 'Hermes'
  const desktopRoot = path.resolve(import.meta.dirname, '..')
  stageWindowsBootstrapTools(context.appOutDir)
  stageWindowsBootstrapInstaller(context.appOutDir, desktopRoot)
  stageWindowsBootstrapRepository(context.appOutDir, desktopRoot)
  stageWindowsPythonRuntime(context.appOutDir, desktopRoot)
  try {
    await stampExeIdentity(path.join(context.appOutDir, `${productName}.exe`), desktopRoot)
  } catch (err) {
    console.warn(`[after-pack] exe identity stamp failed (${err.message}); Hermes.exe keeps the stock Electron icon`)
  }
}

export { findBundledUvCandidate, stageWindowsBootstrapInstaller, stageWindowsBootstrapRepository,
  stageWindowsBootstrapTools, stageWindowsPythonRuntime }
