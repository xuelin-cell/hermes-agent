import { $connection } from '@/store/session'
import { $codeWorkspace } from '@/store/workspace-category'

import { sameWorkdir, workdirKey } from './folders'

/** 发 `config.get` 用的请求函数，由调用方按会话的实际归属路由提供。 */
export type ConfigRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>

/** `config.get project` 的返回里只用到默认目录。 */
type ProjectInfo = null | { cwd?: unknown }

/** 自动文件夹的名字格式，与主进程 `conversationFolderName` 一致，可带同一秒重名后缀。 */
const FOLDER_NAME = /^\d{8}-\d{6}(?:-\d{1,2})?$/

/**
 * 手选目录直接交给后端。未选时办公和学习使用日期文件夹，代码开发复用当前项目或 UniWorkSpace。
 * 通过主进程核对账号工作根后，将实际路径作为显式 cwd 发给后端，以便保存会话归属。
 */
export async function applyConversationFolder(
  params: Record<string, unknown>,
  request: ConfigRequest
): Promise<null | string> {
  const create = window.hermesDesktop?.createConversationFolder

  if (typeof create !== 'function' || $connection.get()?.mode === 'remote') {
    return null
  }

  const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : ''

  if (cwd && params.cwd_explicit === true) {
    return null
  }

  try {
    const profile = typeof params.profile === 'string' ? params.profile : undefined

    const info = (await request('config.get', { key: 'project', ...(profile ? { profile } : {}) })) as ProjectInfo
    const defaultCwd = typeof info?.cwd === 'string' ? info.cwd.trim() : ''

    const code = $codeWorkspace.get()

    if (
      !defaultCwd ||
      (code && cwd && !sameWorkdir(cwd, defaultCwd) && !sameWorkdir(cwd, codeFolderPath(defaultCwd)))
    ) {
      return null
    }

    const folder = code ? await window.hermesDesktop?.ensureCodeFolder?.(defaultCwd) : await create(defaultCwd)

    if (folder) {
      params.cwd = folder
      params.cwd_explicit = true
    }

    return folder ?? null
  } catch {
    // 查不到默认目录或创建失败时保持原行为，不影响发送。
    return null
  }
}

/** 创建会话失败时删掉刚建的空文件夹；没有文件夹或没有接口时什么都不做。 */
export function discardConversationFolder(folder: null | string): void {
  if (folder) {
    void window.hermesDesktop?.discardConversationFolder?.(folder).catch(() => undefined)
  }
}

export const CODE_FOLDER = 'UniWorkSpace'

/** 显示共享代码目录时保留工作根的分隔符。 */
export function codeFolderPath(root: string): string {
  return root.replace(/[\\/]+$/, '') + (root.includes('\\') ? '\\' : '/') + CODE_FOLDER
}

/** 按末级目录名排除自动日期目录和共享代码目录。 */
export function isConversationFolder(path: string): boolean {
  const name = workdirKey(path).split('/').at(-1) ?? ''

  return FOLDER_NAME.test(name) || name === CODE_FOLDER.toLowerCase()
}
