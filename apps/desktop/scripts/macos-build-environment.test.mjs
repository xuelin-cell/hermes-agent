import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'

function withCheckout(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'macos-build-env-')))
  try {
    const scripts = path.join(root, 'scripts')
    const stamps = path.join(root, '.state/inputs')
    const bin = path.join(root, '.state/bin')
    fs.mkdirSync(scripts)
    fs.mkdirSync(stamps, { recursive: true })
    fs.mkdirSync(bin)
    for (const name of ['build-macos-installer.sh', 'build-macos-universal.sh', 'scripts/_activation.sh']) {
      fs.copyFileSync(new URL(`../../../${name}`, import.meta.url), path.join(root, name))
    }
    fs.writeFileSync(path.join(root, 'activate'), 'echo unexpected-activation >&2; exit 73\n')
    fs.writeFileSync(path.join(root, '.gitignore'), '.state/\n')
    fs.writeFileSync(path.join(root, 'uv.lock'), 'prepared input\n')
    fs.writeFileSync(path.join(root, '.state/facts.json'), '{}')
    fs.writeFileSync(path.join(stamps, '.project-root'), root)
    fs.writeFileSync(path.join(stamps, 'uv.lock'), '')
    execFileSync('touch', ['-r', path.join(root, 'uv.lock'), path.join(stamps, 'uv.lock')])
    const hostPython = execFileSync('/bin/bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim()
    const python = path.join(bin, 'python3')
    fs.symlinkSync(hostPython, python)
    // Observe the environment passed to the Universal assembler without building an app.
    fs.mkdirSync(path.join(root, 'apps/desktop/scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'apps/desktop/scripts/macos-universal.mjs'),
      'console.log(process.env.HERMES_PYTHON)\n')
    const env = { ...process.env, HOME: root, HERMES_HOME: path.join(root, '.state'),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, __HERMES_ACTIVATED: path.join(root, '.state/facts.json') }
    for (const args of [['init', '-q'], ['add', '.'],
      ['-c', 'user.name=Build Test', '-c', 'user.email=build@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']]) {
      execFileSync('git', args, { cwd: root, env })
    }
    run({ root, env, python, stamps })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test.skipIf(process.platform !== 'darwin')('macOS entrypoints use the activated interpreter without an in-tree venv', () => {
  withCheckout(({ root, env, python }) => {
    const dryRun = spawnSync('/bin/bash', ['build-macos-installer.sh', '--dry-run'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(dryRun.status, 0, dryRun.stderr)
    assert.ok(dryRun.stdout.includes(python))
    assert.ok(dryRun.stdout.includes('--internal-test-signing'))
    const universal = spawnSync('/bin/bash', ['build-macos-universal.sh', '--x64-app', 'input'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(universal.status, 0, universal.stderr)
    assert.equal(universal.stdout.trim(), python)
    assert.equal(fs.existsSync(path.join(root, '.venv')), false)
  })
})

test.skipIf(process.platform !== 'darwin')('stale activation stops both macOS entrypoints without provisioning dependencies', () => {
  withCheckout(({ root, env, stamps }) => {
    fs.rmSync(path.join(stamps, 'uv.lock'))
    for (const [script, args] of [['build-macos-installer.sh', ['--dry-run']], ['build-macos-universal.sh', ['--x64-app', 'input']]]) {
      const result = spawnSync('/bin/bash', [script, ...args], { cwd: root, env, encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.ok(result.stderr.includes('source ./activate'), result.stderr)
      assert.ok(!result.stderr.includes('unexpected-activation'))
    }
  })
})
