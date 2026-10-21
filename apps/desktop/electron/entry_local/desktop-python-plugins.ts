import fs from 'node:fs'
import path from 'node:path'

/** Both development and installed apps consume build outputs, never account-local code. */
export function desktopPythonPluginsRoot(appRoot: string, resourcesRoot?: string): string {
  return fs.realpathSync(resourcesRoot
    ? path.join(resourcesRoot, 'python-plugins')
    : path.join(appRoot, 'dist', 'python-plugins'))
}

/** User plugins override bundled ones: retire old copies/links before backend discovery. */
export function retireAccountUniAgentGatePlugin(home: string, bundledRoot: string): void {
  for (const name of ['plugin.yaml', 'control.py']) {
    if (!fs.statSync(path.join(bundledRoot, 'uniagentgate', name)).isFile()) {
      throw new Error('发行包缺少 5G 消息插件。')
    }
  }

  const parent = path.join(home, 'plugins')
  const parentInfo = fs.lstatSync(parent, { throwIfNoEntry: false })

  if (parentInfo && (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())) {
    throw new Error('5G 插件目录无效。')
  }

  const previous = path.join(parent, 'uniagentgate')
  const info = fs.lstatSync(previous, { throwIfNoEntry: false })

  if (!info) {return}

  if (!info.isDirectory() && !info.isSymbolicLink()) {throw new Error('5G 插件入口不是目录。')}
  const backups = path.join(home, 'plugin-backups')
  const backupInfo = fs.lstatSync(backups, { throwIfNoEntry: false })

  if (backupInfo && (!backupInfo.isDirectory() || backupInfo.isSymbolicLink())) {
    throw new Error('5G 插件备份目录无效。')
  }

  fs.mkdirSync(backups, { recursive: true, mode: 0o700 })
  const saved = path.join(fs.mkdtempSync(path.join(backups, 'uniagentgate-')), 'plugin')
  // Rename is atomic. If it fails, the original entry remains; link targets are untouched.
  fs.renameSync(previous, saved)
}
