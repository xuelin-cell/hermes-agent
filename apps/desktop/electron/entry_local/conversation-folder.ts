import fs from 'node:fs/promises'
import path from 'node:path'

import { ipcMain, type IpcMainInvokeEvent, type Session } from 'electron'

import { isDesktopRendererSender } from '../desktop-renderer-sender'

/** 同一秒内最多尝试的重名后缀，超过即放弃，不会无限循环。 */
const MAX_SUFFIX = 99

export interface ConversationFolders {
  /** 默认目录就是账号工作区时建一个新文件夹并返回路径；否则返回 null，保持原行为。 */
  create(defaultCwd: string): Promise<null | string>
  /** 只删除本进程刚建、仍为空的文件夹；其它路径一律忽略。 */
  discard(folder: string): Promise<void>
}

/** 本地时间 `YYYYMMDD-HHmmss`，便于用户在资源管理器里认出对话时间。 */
export function conversationFolderName(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0')

  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}` +
    `-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  )
}

/** Windows 路径不区分大小写；其它系统按原样比较。 */
function samePath(a: string, b: string): boolean {
  const left = path.resolve(a)
  const right = path.resolve(b)

  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** 账号工作区必须是真实目录；lstat 不跟随链接，符号链接和目录联接都不算目录，避免文件夹建到别处。 */
async function realDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isDirectory()
  } catch {
    return false
  }
}

/** 每个未选目录的新对话在账号工作区下建一个专属文件夹；名字只由主进程生成。 */
export function createConversationFolders(workspace: string, now: () => Date = () => new Date()): ConversationFolders {
  const created = new Set<string>()

  return {
    async create(defaultCwd) {
      if (!defaultCwd.trim() || !samePath(defaultCwd, workspace) || !(await realDirectory(workspace))) {
        return null
      }

      const base = conversationFolderName(now())

      for (let index = 1; index <= MAX_SUFFIX; index++) {
        const folder = path.join(workspace, index === 1 ? base : `${base}-${index}`)

        try {
          // 不带 recursive 的 mkdir 是独占创建：已存在就失败，不会复用别人的文件夹。
          await fs.mkdir(folder)
          created.add(folder)

          return folder
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            return null
          }
        }
      }

      return null
    },

    async discard(folder) {
      const match = [...created].find(item => samePath(item, folder))

      if (!match) {
        return
      }

      created.delete(match)
      // rmdir 只删空目录；AI 已写入文件时失败并保留文件夹。
      await fs.rmdir(match).catch(() => undefined)
    }
  }
}

/** 只接受当前账号桌面主框架的请求；参数只有页面查到的默认目录或刚拿到的文件夹路径。 */
export function installConversationFolderIpc(
  session: Session,
  rendererUrl: () => string,
  active: () => boolean,
  folders: ConversationFolders
): void {
  /** 与其它账号 IPC 共用来源校验，并要求账号仍处于活动状态。 */
  function trusted(event: IpcMainInvokeEvent): boolean {
    return active() && isDesktopRendererSender(event, session, rendererUrl())
  }

  ipcMain.handle('hermes:conversation-folder:create', async (event, defaultCwd: unknown): Promise<null | string> => {
    if (!trusted(event) || typeof defaultCwd !== 'string' || defaultCwd.length > 4096) {
      return null
    }

    return folders.create(defaultCwd)
  })

  ipcMain.handle('hermes:conversation-folder:discard', async (event, folder: unknown): Promise<void> => {
    if (trusted(event) && typeof folder === 'string' && folder.length <= 4096) {
      await folders.discard(folder)
    }
  })
}
