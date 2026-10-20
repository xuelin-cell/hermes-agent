import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { expect, it } from 'vitest'

import { messagingGatewayLaunch } from './start-messaging-gateway'

const execute = promisify(execFile)

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 20_000

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Native console probe timed out')
    }

    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

// Exercise the host's actual console APIs, a naive descendant, and launcher exit.
it.skipIf(process.platform !== 'win32' || !process.env.HERMES_PYTHON)(
  'keeps the gateway and its descendants invisible and alive after the launcher exits',
  async () => {
    const python = process.env.HERMES_PYTHON

    if (!python) {
      throw new Error('Set HERMES_PYTHON to a test Python interpreter')
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes 5g 控制台 '))
    const result = path.join(root, 'result.json')
    const release = path.join(root, 'release')
    const script = path.join(root, 'probe.py')
    const repo = path.resolve(import.meta.dirname, '../../../..')
    let pid: number | undefined
    const visible = `import ctypes, ctypes.wintypes\nctypes.windll.kernel32.GetConsoleWindow.restype = ctypes.wintypes.HWND\nprint(int(bool(ctypes.windll.user32.IsWindowVisible(ctypes.windll.kernel32.GetConsoleWindow()))))`
    fs.writeFileSync(
      script,
      `import json, os, subprocess, sys, time\nfrom pathlib import Path\n${visible}\nchild = subprocess.check_output([sys.executable, '-c', ${JSON.stringify(visible)}], text=True)\nPath(sys.argv[1]).write_text(json.dumps({'pid': os.getpid(), 'visible': int(bool(ctypes.windll.user32.IsWindowVisible(ctypes.windll.kernel32.GetConsoleWindow()))), 'child_visible': int(child.strip())}))\nwhile not Path(sys.argv[2]).exists(): time.sleep(0.1)\n`
    )
    const launch = messagingGatewayLaunch(python, [script, result, release])
    const log = path.join(root, 'launch.log')

    const relay = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
const fd=fs.openSync(${JSON.stringify(log)},'a');
const child=spawn(${JSON.stringify(launch.command)},${JSON.stringify(launch.args)},
{cwd:${JSON.stringify(root)},env:{...process.env,PYTHONPATH:${JSON.stringify(repo)}},detached:${launch.detached},windowsHide:true,stdio:['ignore',fd,fd]});
child.once('error',()=>process.exit(2)); child.once('close',code=>process.exit(code??1));`

    try {
      await execute(process.execPath, ['-e', relay], { windowsHide: true, timeout: 20_000 })
      await until(() => fs.existsSync(result))
      const probe = JSON.parse(fs.readFileSync(result, 'utf8'))
      pid = probe.pid
      expect(probe.visible).toBe(0)
      expect(probe.child_visible).toBe(0)
      expect(() => process.kill(pid!, 0)).not.toThrow()
    } catch (error) {
      throw new Error(`${error}\n${fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''}`)
    } finally {
      fs.writeFileSync(release, '')

      if (pid) {
        await until(() => {
          try {
            process.kill(pid!, 0)

            return false
          } catch {
            return true
          }
        })
      }

      fs.rmSync(root, { recursive: true, force: true })
    }
  },
  60_000
)
