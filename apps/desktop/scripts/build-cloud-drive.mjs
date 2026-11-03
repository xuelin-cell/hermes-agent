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
// tool_search only indexes ASCII words, so Chinese-only descriptions are reachable by tool name
// alone and lose to connectors with English text (e.g. "upload to 个人云盘" picked Youdao Note).
const DRIVE = "the user's personal cloud drive (个人云盘 / 资料库)"
const SEARCH_SUMMARIES = {
  list_files: `List files and folders in one directory of ${DRIVE}, one page at a time.`,
  filesearch: `Search ${DRIVE} for files and folders by name.`,
  make_dir: `Create a new folder (create directory) in ${DRIVE}.`,
  rename_file: `Rename a file or folder in ${DRIVE}.`,
  move_files: `Move files or folders to another folder in ${DRIVE}.`,
  delete_files: `Delete files or folders from ${DRIVE}: move them to the trash (recycle bin) or purge them permanently.`,
  get_file_info: `Get details of a file or folder in ${DRIVE}: name, size, parent folder and timestamps.`,
  list_recycle_bin: `List deleted items in the trash (recycle bin) of ${DRIVE}, one page at a time.`,
  restore_files: `Restore deleted files or folders from the trash (recycle bin) of ${DRIVE}.`,
  get_capacity: `Get the storage capacity, quota and used space of ${DRIVE}.`,
  download: `Download a file or document from ${DRIVE} into the workspace so it can be read.`,
  upload: `Upload (save, store) a file, document or attachment from the workspace to ${DRIVE}.`
}
const missing = module.DRIVE_MCP_TOOLS.map(tool => tool.name).filter(name => !SEARCH_SUMMARIES[name])
if (missing.length) {
  throw new Error(`Add an English tool_search summary for cloud drive tools: ${missing.join(', ')}`)
}
await writeFile(
  root + 'plugins/cloud_drive/tools.json',
  JSON.stringify(
    module.DRIVE_MCP_TOOLS.map(tool => ({
      ...tool,
      description: `${SEARCH_SUMMARIES[tool.name]} ${tool.description
        .replaceAll('当前桌面账号', '当前授权账号')
        .replaceAll('本机 path', '实例内 path')
        .replace('仅适用于与桌面同机的 Hermes。', '')
        .replaceAll('当前机器', '当前用户实例')}`
    })),
    null,
    2
  ) + '\n'
)
