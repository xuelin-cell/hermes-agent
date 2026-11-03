import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url))
await build({ absWorkingDir: root,
  entryPoints: [root + 'apps/desktop/electron/login/cloud-account-worker.ts'],
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: root + 'deploy/hermes-mt/entry/entry/static/cloud-account-worker.mjs',
  banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" },
  plugins: [{ name: 'entry-fetch', setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'entry-fetch' }))
    build.onLoad({ filter: /.*/, namespace: 'entry-fetch' }, () => ({ contents: 'export const net = {fetch: globalThis.fetch}' }))
  } }]
})
