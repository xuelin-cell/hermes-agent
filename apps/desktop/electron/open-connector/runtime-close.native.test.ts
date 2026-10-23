import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import { ConnectorRuntime } from './runtime'

it.each([false, true])('真实连接器退出：忽略正常停止信号=%s，并发关闭等待同一次收尾', async ignoreTerm => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-connector-close-'))
  const directory = path.join(root, 'data')
  fs.mkdirSync(path.join(root, 'src/server'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules/hono'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src/server/index.ts'), '')
  fs.writeFileSync(path.join(root, 'desktop-entry.mjs'), `
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
fs.writeFileSync(path.join(process.env.OOMOL_CONNECT_DATA_DIR, 'pid'), String(process.pid))
const server = http.createServer((_req, res) => res.end('ok'))
server.listen(Number(process.env.PORT), '127.0.0.1')
process.on('SIGTERM', () => { ${ignoreTerm ? '' : 'server.close(() => process.exit(0))'} })
`)
  const runtime = new ConnectorRuntime({
    directory, runtimeDirectory: root, executable: createRequire(import.meta.url)('electron'),
    encrypt: value => Buffer.from(value), decrypt: value => value.toString()
  })
  let pid: number | undefined

  try {
    const config = await runtime.config('amap')
    pid = Number(fs.readFileSync(path.join(directory, 'pid'), 'utf8'))
    await Promise.all([runtime.close(), runtime.close()])
    expect(() => process.kill(pid!, 0)).toThrow()
    await expect(fetch(config.url as string)).rejects.toThrow()
    await expect(runtime.start()).rejects.toThrow('已关闭')
    expect(fs.existsSync(path.join(directory, 'secrets.enc'))).toBe(true)
  } finally {
    if (pid) {
      try { process.kill(pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error }
      }
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
