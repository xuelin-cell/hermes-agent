import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { createAccountGatewayLogout } from './gateway-logout'

it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
  'bootstrap Python loads each account’s PM dependencies before recovery snapshot (A→B→A)',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-bootstrap-'))
    const repository = path.resolve(import.meta.dirname, '../../../..')
    const testPython = process.env.HERMES_TEST_PYTHON ?? path.join(repository, '.venv/bin/python')
    const fixtureEnv = { PATH: process.env.PATH, HOME: root, HERMES_HOME: path.join(root, 'unused') }

    if (process.env.SYSTEMROOT) {
      Object.assign(fixtureEnv, { SYSTEMROOT: process.env.SYSTEMROOT })
    }

    vi.stubEnv('HOME', root)
    vi.stubEnv('HERMES_HOME', path.join(root, 'wrong-home'))
    vi.stubEnv('HERMES_DISABLE_LAZY_INSTALLS', '1')

    try {
      const details = JSON.parse(
        execFileSync(
          testPython,
          [
            '-c',
            'import json,sys,sysconfig; print(json.dumps({"version":f"{sys.version_info.major}.{sys.version_info.minor}","packages":sysconfig.get_path("purelib")}))'
          ],
          { env: fixtureEnv, encoding: 'utf8' }
        )
      )

      const bootstrap = path.join(root, 'bootstrap')

      execFileSync(testPython, ['-m', 'venv', '--without-pip', bootstrap], { env: fixtureEnv })

      const python = path.join(bootstrap, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

      expect(
        execFileSync(python, ['-c', 'import importlib.util; print(importlib.util.find_spec("psutil"))'], {
          env: fixtureEnv,
          encoding: 'utf8'
        }).trim()
      ).toBe('None')

      const key = createHash('sha256').update(fs.realpathSync.native(repository)).digest('hex').slice(0, 16)

      for (const name of ['a', 'b']) {
        const home = path.join(root, name)
        const state = path.join(home, 'installs', key)
        const generation = path.join(state, 'environments', 'fixture')

        const packages = path.join(
          generation,
          process.platform === 'win32' ? 'Lib/site-packages' : `lib/python${details.version}/site-packages`
        )

        fs.mkdirSync(path.dirname(packages), { recursive: true })
        fs.writeFileSync(path.join(generation, 'pyvenv.cfg'), `version = ${details.version}.0\n`)
        fs.symlinkSync(details.packages, packages, process.platform === 'win32' ? 'junction' : 'dir')
        fs.writeFileSync(
          path.join(state, 'facts.json'),
          JSON.stringify({ packages: { venv: { environment: generation } } })
        )
        fs.writeFileSync(path.join(home, 'history-sentinel'), name)
      }

      for (const name of ['a', 'b', 'a']) {
        const home = path.join(root, name)

        const gateway = createAccountGatewayLogout({
          id: 'fixture',
          home,
          workspace: root,
          desktopState: root,
          installationRoot: repository,
          python
        })

        try {
          const snapshot = await gateway.run('snapshot')

          expect(snapshot.gateways).toEqual([])
          expect(snapshot.processes.some(row => row.pid === process.pid)).toBe(true)
          expect(await gateway.run('check')).toEqual({ processes: [], gateways: [] })
          expect(fs.readFileSync(path.join(home, 'history-sentinel'), 'utf8')).toBe(name)
        } finally {
          await gateway.dispose()
        }
      }

      expect(fs.existsSync(path.join(root, 'wrong-home/installs'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
  60_000
)
