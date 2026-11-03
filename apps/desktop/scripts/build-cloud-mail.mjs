import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const root = fileURLToPath(new URL('../../../', import.meta.url))
await build({
  entryPoints: [root + 'apps/desktop/services/open-connector/cloud/worker.ts'],
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import { createRequire as cloudRequire } from 'node:module'; const require = cloudRequire(import.meta.url);" },
  outfile: root + 'plugins/cloud_mail/worker.mjs'
})
const catalog = JSON.parse(execFileSync(process.execPath, [root + 'plugins/cloud_mail/worker.mjs'], {
  input: '{"id":"catalog","operation":"tools"}\n', encoding: 'utf8'
}))
await writeFile(root + 'plugins/cloud_mail/tools.json', JSON.stringify(catalog.result, null, 2) + '\n')
