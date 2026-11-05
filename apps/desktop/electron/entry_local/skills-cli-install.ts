import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app } from 'electron'

import { resolveAccountInstallation } from './runtime-installation'
import { installSkillsCli } from './skills-cli-registration.mjs'

/** 完整安装包启动后注册当前应用；更新或移动应用后下次启动刷新入口。 */
export async function registerPackagedSkillsCli(): Promise<void> {
  if (!app.isPackaged || !['win32', 'darwin'].includes(process.platform)) {
    return
  }

  const runtime = resolveAccountInstallation('')

  const directory = path
    .dirname(fileURLToPath(import.meta.url))
    .replace(/([\\/])(app(?:-(?:arm64|x64))?\.asar)([\\/])/, '$1$2.unpacked$3')

  await installSkillsCli({ executable: process.execPath, python: runtime.python, helperDirectory: directory })
}
