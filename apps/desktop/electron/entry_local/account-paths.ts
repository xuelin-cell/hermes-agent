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

  return {
    id,
    home: path.join(roots.data, 'accounts', id, 'hermes-home'),
    workspace: path.join(roots.data, 'accounts', id, 'workspace'),
    desktopState: path.join(roots.userData, 'accounts', id, 'desktop-state')
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

  for (const root of [roots.data, roots.userData]) {
    ensureDirectory(root)
    ensureDirectory(path.join(root, 'accounts'))
    ensureDirectory(path.join(root, 'accounts', paths.id))
  }

  for (const directory of [paths.home, paths.workspace, paths.desktopState]) {
    ensureDirectory(directory)
  }

  return Object.freeze(paths)
}
