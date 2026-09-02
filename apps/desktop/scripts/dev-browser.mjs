#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')
const PORT = process.env.HERMES_BROWSER_DEV_BACKEND_PORT || '9120'
const TOKEN = process.env.HERMES_BROWSER_DEV_TOKEN || 'hermes-browser-dev'

function pythonCandidates() {
  const runtimeCache = path.join(DESKTOP_ROOT, '.runtime-cache', `${process.platform}-${process.arch}`)
  const cached = fs.existsSync(runtimeCache)
    ? fs
        .readdirSync(runtimeCache)
        .sort()
        .reverse()
        .map(name => path.join(runtimeCache, name, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
    : []

  return [
    process.env.HERMES_BROWSER_DEV_PYTHON,
    path.join(REPO_ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    path.join(REPO_ROOT, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    ...cached
  ].filter(Boolean)
}

const python = pythonCandidates().find(candidate => fs.existsSync(candidate))

if (!python) {
  throw new Error('No Hermes Python environment found. Build the desktop runtime once or set HERMES_BROWSER_DEV_PYTHON.')
}

const children = new Set()
const launch = (command, args, options = {}) => {
  const child = spawn(command, args, { cwd: DESKTOP_ROOT, stdio: 'inherit', ...options })
  children.add(child)
  child.on('exit', code => {
    children.delete(child)
    if (!stopping && code !== 0) shutdown(code ?? 1)
  })
  return child
}

let stopping = false
function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill()
  setTimeout(() => process.exit(code), 100).unref()
}

process.on('SIGINT', () => shutdown())
process.on('SIGTERM', () => shutdown())

console.log(`Hermes browser backend: http://127.0.0.1:${PORT}`)
launch(python, ['-m', 'hermes_cli.main', 'serve', '--host', '127.0.0.1', '--port', PORT, '--skip-build'], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    HERMES_DASHBOARD_SESSION_TOKEN: TOKEN,
    PYTHONPATH: REPO_ROOT
  }
})

const npmCli = process.env.npm_execpath

if (!npmCli) {
  throw new Error('npm CLI path is unavailable. Start this command through npm run dev:browser.')
}

launch(process.execPath, [npmCli, 'run', 'dev:renderer', '--', '--open'], {
  env: {
    ...process.env,
    VITE_HERMES_BROWSER_BACKEND: `http://127.0.0.1:${PORT}`,
    VITE_HERMES_BROWSER_TOKEN: TOKEN
  }
})
