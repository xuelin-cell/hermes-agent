import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface AccountRoots {
  data: string
  userData: string
}

export interface AccountPaths {
  id: string
  home: string
  workspace: string
  desktopState: string
}

// 硬盘目录名只取摘要前 12 位（48 位），身份仍以完整摘要为准并由标识文件核对。
const DIRECTORY_DIGEST_LENGTH = 12
const ACCOUNT_ID_FILE = 'account-id'

/** 账号数据根统一为 uniworker，账号下仍使用短目录以减少 Windows 深层路径长度。 */
export function accountDataRoot(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    const base = (env.LOCALAPPDATA || '').trim() || path.win32.join(home, 'AppData', 'Local')

    return path.win32.join(base, 'uniworker')
  }

  return path.posix.join(home, '.uniworker')
}

/** 用完整身份二元组生成稳定标识，UID 原文不会成为路径组件。 */
export function resolveAccountPaths(roots: AccountRoots, namespace: string, uid: string): AccountPaths {
  if (!namespace || namespace !== namespace.trim() || !uid || uid !== uid.trim()) {
    throw new Error('账号身份无效。')
  }

  if (!path.isAbsolute(roots.data) || !path.isAbsolute(roots.userData)) {
    throw new Error('账号数据根目录必须为绝对路径。')
  }

  const id = `account-${createHash('sha256')
    .update(JSON.stringify([namespace, uid]), 'utf8')
    .digest('hex')}`

  return accountPathsById(roots, id)
}

/** 用已落盘的安全标识定位原账号；恢复清理不依赖仍然有效的登录凭据。 */
export function accountPathsById(roots: AccountRoots, id: string): AccountPaths {
  if (!/^account-[a-f0-9]{64}$/.test(id) || !path.isAbsolute(roots.data) || !path.isAbsolute(roots.userData)) {
    throw new Error('账号恢复标识无效。')
  }

  const name = id.slice('account-'.length, 'account-'.length + DIRECTORY_DIGEST_LENGTH)
  const directory = path.join(roots.data, name)

  return {
    id,
    home: path.join(directory, 'home'),
    workspace: path.join(directory, 'workspace'),
    desktopState: path.join(roots.userData, 'accounts', name, 'desktop-state')
  }
}

/** 核对数据目录与桌面状态目录都属于本账号；缺少标识文件时按 allowCreate 决定补写或拒绝。 */
export function assertAccountDirectoryOwner(paths: AccountPaths, allowCreate = false): void {
  for (const directory of [path.dirname(paths.home), path.dirname(paths.desktopState)]) {
    assertDirectoryOwner(path.join(directory, ACCOUNT_ID_FILE), paths.id, allowCreate)
  }
}

/** 核对单个短目录的身份标识文件。 */
function assertDirectoryOwner(file: string, id: string, allowCreate: boolean): void {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })

  if (!stat) {
    if (!allowCreate) {
      throw new Error('账号目录缺少身份标识。')
    }

    // wx 不覆盖并发写入的标识；随后仍按下方读取结果核对。
    try {
      fs.writeFileSync(file, id, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  } else if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('账号身份标识不是普通文件。')
  }

  if (fs.readFileSync(file, 'utf8') !== id) {
    throw new Error('账号目录属于另一账号。')
  }
}

/** 检查既有目录后才创建，拒绝符号链接、Windows junction 和文件占位。 */
function ensureDirectory(directory: string): void {
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false })

  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error('账号目录必须是普通目录。')
  }

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
}

/** 逐层准备受管目录；重复初始化保留内容，不导入旧 Home。 */
export function prepareAccountPaths(roots: AccountRoots, namespace: string, uid: string): AccountPaths {
  const paths = resolveAccountPaths(roots, namespace, uid)

  for (const directory of [
    roots.data,
    path.dirname(paths.home),
    roots.userData,
    path.join(roots.userData, 'accounts'),
    path.dirname(paths.desktopState)
  ]) {
    ensureDirectory(directory)
  }

  // 先核对归属再创建子目录，摘要前缀相同的另一账号不会写进本目录。
  assertAccountDirectoryOwner(paths, true)

  for (const directory of [paths.home, paths.workspace, paths.desktopState]) {
    ensureDirectory(directory)
  }

  return Object.freeze(paths)
}
