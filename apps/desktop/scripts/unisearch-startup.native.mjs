import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { build } from 'esbuild'
import electronPath from 'electron'

const desktop = path.resolve(import.meta.dirname, '..')
const repository = path.resolve(desktop, '../..')
const testPython = process.env.HERMES_TEST_PYTHON ?? path.join(repository, '.venv/bin/python')

for (const bundled of [false, true]) {
  test(
    `真实 Electron：${bundled ? '载荷依赖路径' : '开发账号 PM 环境'}本地配置就绪后打开桌面，联网刷新在后台完成`,
    { timeout: 45_000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unisearch-startup-'))
      try {
        const env = {
          PATH: process.env.PATH,
          HOME: root,
          HERMES_HOME: path.join(root, 'wrong-home'),
          HERMES_DISABLE_LAZY_INSTALLS: '1',
          HERMES_DESKTOP_CDP_PORT: 'off'
        }
        if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT
        const details = JSON.parse(
          execFileSync(
            testPython,
            [
              '-c',
              'import json,sys,sysconfig; print(json.dumps({"version":f"{sys.version_info.major}.{sys.version_info.minor}","packages":sysconfig.get_path("purelib")}))'
            ],
            { env, encoding: 'utf8' }
          )
        )
        const bootstrap = path.join(root, 'bootstrap')
        execFileSync(testPython, ['-m', 'venv', '--without-pip', bootstrap], { env })
        const python = path.join(bootstrap, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
        const home = path.join(root, 'account-home')
        const appRoot = path.join(root, 'app')
        const output = path.join(root, 'fixture.mjs')
        fs.mkdirSync(home)
        fs.mkdirSync(appRoot)
        execFileSync(
          process.execPath,
          [
            path.join(desktop, 'scripts/stage-python-plugins.mjs'),
            '--source',
            repository,
            '--out',
            path.join(appRoot, 'dist')
          ],
          { env }
        )
        // The native test controls only installation: PM bootstrap and preparation script execute
        // for real, while package downloads are stubbed inside this temporary test payload.
        const prepared = path.join(appRoot, 'dist/python-plugins/unisearch/prepare.py')
        const originalPrepare = path.join(appRoot, 'dist/python-plugins/unisearch/prepare-real.py')
        fs.renameSync(prepared, originalPrepare)
        fs.writeFileSync(
          prepared,
          `import hermes_bootstrap, runpy\nfrom unittest.mock import patch\nwith patch('pm.ensure') as ensure, patch('pm.sync_venv'):\n    runpy.run_path(${JSON.stringify(originalPrepare)}, run_name='__main__')\n    ensure.assert_called_once_with('chromium')\n`
        )
        await build({
          stdin: {
            resolveDir: desktop,
            contents: `
          import { app, net } from 'electron'
          import fs from 'node:fs'
          import path from 'node:path'
          import { parse } from 'yaml'
          import { startAccountDesktop } from './electron/entry_local/desktop-runtime.ts'
          import { refreshUniSearch } from './electron/entry_local/unisearch.ts'
          process.on('uncaughtException', error => { console.error(error); app.exit(1) })
          app.setAppPath(${JSON.stringify(appRoot)})
          for (const key of ['home', 'appData', 'userData']) app.setPath(key, ${JSON.stringify(root)})
          globalThis.probe = []
          const networkReady = new Promise(resolve => { globalThis.releaseSearch = resolve })
          net.fetch = async () => {
            await networkReady
            if (globalThis.probe[0] !== 'prepared') throw new Error('Search ran before dependency preparation')
            globalThis.probe.push('search')
            return Response.json({configValue:JSON.stringify({unisearch_backend:'bocha'})})
          }
          void app.whenReady().then(async () => {
            try {
              const context = {id:'fixture-account', home:${JSON.stringify(home)}, workspace:${JSON.stringify(root)},
                python:${JSON.stringify(python)}, installationRoot:${JSON.stringify(repository)},
                ${bundled ? `sitePackages:${JSON.stringify(details.packages)}` : ''}}
              const owner = {uid:'fixture-uid', token:'fixture-token', expiresAt:Date.now()+60_000, maskedPhone:'***'}
              await startAccountDesktop(context, () => owner)
              if (!await refreshUniSearch(context, () => owner, net.fetch, app.getAppPath())) throw new Error('Background config did not complete')
              const finalConfig = parse(fs.readFileSync(path.join(context.home,'config.yaml'),'utf8'))
              if (finalConfig.plugins.entries.unisearch.settings.backend !== 'bocha') throw new Error('Cloud config not saved')
              const saved = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(home, 'config-proof.json'))},'utf8'))
              if (!saved.localReady) throw new Error('Missing local plugin configuration')
              if (fs.existsSync(path.join(${JSON.stringify(root)},'wrong-home/config.yaml'))) throw new Error('Wrong Home written')
              console.log('UNISEARCH_STARTUP_OK ' + JSON.stringify(globalThis.probe))
              app.exit(0)
            } catch(error) { console.error(error, error.cause); app.exit(1) }
          })
        `
          },
          bundle: true,
          platform: 'node',
          format: 'esm',
          target: 'node22',
          external: ['electron'],
          outfile: output,
          banner: {
            js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
          },
          plugins: [
            {
              name: 'offline-startup-boundaries',
              /** 启动探针只控制下载与最终UI边界，账号环境和配置脚本保持真实。 */
              setup(builder) {
                // Only dependency installation and the final UI are controlled. The Electron runtime,
                // PM activation, selected Python subprocess, staging and config writer are real.
                builder.onLoad({ filter: /entry_local[\\/]dev-extras\.ts$/ }, () => ({
                  loader: 'ts',
                  contents: `
            import fs from 'node:fs'
            import path from 'node:path'
            import { createHash } from 'node:crypto'
            /** 隔离夹具只准备账号PM选择，不实际下载依赖。 */
            export async function ensureDevExtras(context, env) {
              if (fs.existsSync(path.join(context.home,'config.yaml'))) throw new Error('Configuration ran too early')
              if (!context.sitePackages) {
                const key = createHash('sha256').update(fs.realpathSync.native(context.installationRoot)).digest('hex').slice(0,16)
                const state = path.join(context.home,'installs',key)
                const generation = path.join(state,'environments','fixture')
                const packages = path.join(generation,${JSON.stringify(process.platform === 'win32' ? 'Lib/site-packages' : `lib/python${details.version}/site-packages`)})
                fs.mkdirSync(path.dirname(packages),{recursive:true})
                fs.writeFileSync(path.join(generation,'pyvenv.cfg'),${JSON.stringify(`version = ${details.version}.0\n`)})
                fs.symlinkSync(${JSON.stringify(details.packages)},packages,${JSON.stringify(process.platform === 'win32' ? 'junction' : 'dir')})
                fs.writeFileSync(path.join(state,'facts.json'),JSON.stringify({packages:{venv:{environment:generation}}}))
              }
              globalThis.probe.push('prepared')
            }
          `
                }))
                builder.onLoad({ filter: /electron[\\/]main\.ts$/ }, () => ({
                  loader: 'ts',
                  contents: `
            import fs from 'node:fs'
            import path from 'node:path'
            import { parse } from 'yaml'
            /** 桌面先读取本地插件配置，再释放远端刷新响应。 */
            export async function openAccountDesktop() {
              const config = parse(fs.readFileSync(path.join(process.env.HERMES_HOME,'config.yaml'),'utf8'))
              if (config.web.search_backend !== 'unisearch' || !config.plugins.enabled.includes('unisearch')) {
                throw new Error('Desktop opened without configured search')
              }
              fs.writeFileSync(path.join(process.env.HERMES_HOME,'config-proof.json'),JSON.stringify({localReady:true}))
              globalThis.probe.push('desktop')
              globalThis.releaseSearch()
            }
          `
                }))
              }
            }
          ]
        })
        const child = spawnSync(electronPath, [output], {
          env,
          cwd: desktop,
          encoding: 'utf8',
          timeout: 30_000,
          killSignal: 'SIGKILL'
        })
        assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}\n${child.error ?? ''}`)
        assert.ok(child.stdout.includes('UNISEARCH_STARTUP_OK ["prepared","desktop","search"]'))
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )
}
