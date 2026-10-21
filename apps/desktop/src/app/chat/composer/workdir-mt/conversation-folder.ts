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
 * 未选目录的新对话发送前，在账号工作区下建一个专属文件夹，并改为以“用户选了这个目录”发给后端。
 * 只有这次用选择器或侧边栏文件夹“+”选的目录才算选了；日常办公和学习里，启动时记住的上次目录、
 * 进过的侧边栏文件夹都是带过来的，照样新建，与 UniWork 一致。代码开发保持原样，沿用带过来的目录。
 * 任何一个条件不满足都原样返回 null：没有主进程接口（云端或非账号环境）、远程连接、
 * 用户选了目录、代码开发带着别的目录、该档案默认目录不是账号工作区（专家自带目录）。
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

    if (!defaultCwd || (cwd && !sameWorkdir(cwd, defaultCwd) && $codeWorkspace.get())) {
      return null
    }

    const folder = await create(defaultCwd)

    if (folder) {
      params.cwd = folder
      params.cwd_explicit = true
    }

    return folder
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

/** 是否为默认工作区下自动建的对话文件夹，“最近使用”里不列出它们。 */
export function isConversationFolder(path: string, defaultCwd: string): boolean {
  const key = workdirKey(path)
  const parent = workdirKey(defaultCwd)
  const name = key.slice(parent.length + 1)

  return Boolean(parent) && key.startsWith(`${parent}/`) && FOLDER_NAME.test(name)
}
