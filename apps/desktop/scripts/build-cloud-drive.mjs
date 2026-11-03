import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url))
await build({
  absWorkingDir: root,
  entryPoints: [root + 'apps/desktop/electron/login/cloud-drive-worker.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: root + 'deploy/hermes-mt/entry/entry/static/cloud-drive-worker.mjs'
})
const tools = await build({
  absWorkingDir: root,
  entryPoints: [root + 'apps/desktop/electron/login/cloud-drive-mcp-tools.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false
})
const module = await import('data:text/javascript;base64,' + Buffer.from(tools.outputFiles[0].text).toString('base64'))
await writeFile(
  root + 'plugins/cloud_drive/tools.json',
  JSON.stringify(
    module.DRIVE_MCP_TOOLS.map(tool => ({
      ...tool,
      description: tool.description
        .replaceAll('当前桌面账号', '当前授权账号')
        .replaceAll('本机 path', '实例内 path')
        .replace('仅适用于与桌面同机的 Hermes。', '')
        .replaceAll('当前机器', '当前用户实例')
    })),
    null,
    2
  ) + '\n'
)
