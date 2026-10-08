import fs from 'node:fs'
import path from 'node:path'

import { type AccountPaths, accountPathsById, type AccountRoots } from './account-paths'

/** 仅缩短 Windows 的 PM 依赖树；账号 Home、配置和工作文件保持原位。 */
export function prepareAccountDependencyStorage(roots: AccountRoots, account: AccountPaths): void {
  if (process.platform !== 'win32') {return}

  const expected = accountPathsById(roots, account.id)

  if (path.resolve(account.home) !== expected.home) {
    throw new Error('账号依赖目录归属无效。')
  }

  const parent = path.join(roots.data, 'deps')
  const target = path.join(parent, account.id.slice('account-'.length))
  const source = path.join(account.home, 'installs')

  for (const directory of [roots.data, path.join(roots.data, 'accounts'), path.dirname(account.home), account.home, parent, target]) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false })

    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error('账号依赖存储必须位于真实目录。')
    }
  }

  const current = fs.lstatSync(source, { throwIfNoEntry: false })

  if (current?.isSymbolicLink()) {
    // 仅接受本账号的固定目标，不接受任意外部联接或另一账号的依赖树。
    if (fs.realpathSync(source).toLowerCase() !== path.resolve(target).toLowerCase()) {
      throw new Error('账号依赖目录联接目标不符。')
    }

    return
  }

  if (current && !current.isDirectory()) {
    throw new Error('账号依赖目录被文件占用。')
  }

  fs.mkdirSync(parent, { recursive: true })

  if (current) {
    if (fs.existsSync(target)) {
      throw new Error('账号依赖目录存在冲突，请保留两处内容。')
    }

    // 两处均在同一受管根内；重命名不复制、不删除依赖，联接失败则恢复原位置。
    fs.renameSync(source, target)
  } else {
    // 上次恰好在重命名后中断时，复用已保存的目标补全联接。
    fs.mkdirSync(target, { recursive: true })
  }

  try {
    fs.symlinkSync(target, source, 'junction')
  } catch (error) {
    if (current) {fs.renameSync(target, source)}
    throw error
  }
}
