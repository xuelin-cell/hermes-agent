import { build } from 'esbuild'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = process.argv[2] ?? `${root}deploy/hermes-mt/.connector-runtime`
await mkdir(output, { recursive: true })
const contract = await build({ absWorkingDir: root,
  entryPoints: [`${root}apps/desktop/services/open-connector/cloud/contract.ts`],
  bundle: true, platform: 'node', format: 'esm', write: false, tsconfigRaw: { compilerOptions: {} }
})
const metadata = await import('data:text/javascript;base64,' + Buffer.from(contract.outputFiles[0].text).toString('base64'))
await writeFile(`${output}/contract.json`, JSON.stringify(metadata.CLOUD_CONNECTOR_SPECS) + '\n')
await build({ absWorkingDir: root,
  tsconfigRaw: { compilerOptions: {} },
  entryPoints: [`${root}apps/desktop/services/open-connector/cloud/connectors-entry.ts`],
  outfile: `${output}/src/server/storage/worker.mjs`, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" }
})
// Preserve the SQLite store's existing import.meta-relative migration layout.
await cp(`${root}apps/desktop/services/open-connector/migrations`, `${output}/migrations`, { recursive: true })
