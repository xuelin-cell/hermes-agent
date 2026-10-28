import fs from 'node:fs'
import path from 'node:path'

import { ipcMain, type IpcMainInvokeEvent, type Session } from 'electron'

import { isDesktopRendererSender } from '../desktop-renderer-sender'
import { writeSecretFileAtomic } from '../hardening'

/** 重新打开程序后，被中断的回答在这段时间内可以点 ▶ 继续。 */
export const RESUME_WINDOW_MS = 15 * 60 * 1000

/** Hermes 每轮开始写、正常结束擦掉的记录；留下来的就是程序没了时正在跑的那一轮。 */
const MARKER_FILE = 'interrupted_turns.json'
/** 转到桌面版自己的记录里，带上发现时间，作为 15 分钟的起点。 */
const STORE_FILE = 'uniwork-interrupted-turns.json'
const MAX_PROMPT_CHARS = 64_000
const MAX_SESSION_ID = 512

export interface InterruptedTurn {
  sessionId: string
  /** 被中断那一轮用户原来的请求，续跑时一并交给模型。 */
  prompt: string
  /** 桌面版发现这条记录的时间（毫秒）。 */
  detectedAt: number
}

type Store = Record<string, { detectedAt: number; prompt: string }>

/** 判断是不是普通对象，JSON 里的数组和空值都不算。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读 JSON 对象；文件缺失或损坏都当作空，不影响启动。 */
function readObject(file: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))

    return isRecord(data) ? data : {}
  } catch {
    return {}
  }
}

/** 原子写入；没有内容就删掉文件，和 Hermes 的做法一致。 */
function writeObject(file: string, data: Record<string, unknown>): void {
  if (!Object.keys(data).length) {
    fs.rmSync(file, { force: true })

    return
  }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeSecretFileAtomic(file, JSON.stringify(data), { encoding: 'utf8' })
}

/** 只留还在 15 分钟内、格式正确的记录。 */
function freshStore(data: Record<string, unknown>, now: number): Store {
  const store: Store = {}

  for (const [sessionId, entry] of Object.entries(data)) {
    if (!isRecord(entry) || typeof entry.prompt !== 'string' || typeof entry.detectedAt !== 'number') {
      continue
    }

    const age = now - entry.detectedAt

    if (age >= 0 && age < RESUME_WINDOW_MS) {
      store[sessionId] = { detectedAt: entry.detectedAt, prompt: entry.prompt }
    }
  }

  return store
}

/**
 * 写记录的后端进程是否还活着。还活着说明有别的后端（例如另一个安装实例）正在跑这一轮，
 * 不能当成中断，留给 Hermes 自己处理。
 */
export function markerWriterAlive(entry: Record<string, unknown>): boolean {
  const pid = entry.writer_pid

  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false
  }

  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 后端启动前调用：把 Hermes 留下的中断记录搬到桌面版自己的记录里，
 * 这样后端打开会话时找不到记录，就不会自动续跑，改由用户点 ▶ 决定。
 * 先写自己的记录再改 Hermes 的文件，中途出错最多退回到原来的自动续跑。
 */
export function claimInterruptedTurns(
  home: string,
  now = Date.now(),
  alive: (entry: Record<string, unknown>) => boolean = markerWriterAlive
): InterruptedTurn[] {
  const dir = path.join(home, 'desktop')
  const markerFile = path.join(dir, MARKER_FILE)
  const storeFile = path.join(dir, STORE_FILE)
  const markers = readObject(markerFile)
  const store = freshStore(readObject(storeFile), now)
  const kept: Record<string, unknown> = {}
  let moved = false

  for (const [sessionId, entry] of Object.entries(markers)) {
    const prompt = isRecord(entry) && typeof entry.prompt === 'string' ? entry.prompt : ''

    if (
      !isRecord(entry) ||
      !prompt.trim() ||
      sessionId.length > MAX_SESSION_ID ||
      entry.auto_continue === false ||
      alive(entry)
    ) {
      kept[sessionId] = entry

      continue
    }

    store[sessionId] = { detectedAt: now, prompt: prompt.slice(0, MAX_PROMPT_CHARS) }
    moved = true
  }

  writeObject(storeFile, store)

  if (moved) {
    writeObject(markerFile, kept)
  }

  return Object.entries(store).map(([sessionId, entry]) => ({ sessionId, ...entry }))
}

/** 读出某个账号目录下仍可续跑的记录。 */
export function listInterruptedTurns(home: string, now = Date.now()): InterruptedTurn[] {
  const store = freshStore(readObject(path.join(home, 'desktop', STORE_FILE)), now)

  return Object.entries(store).map(([sessionId, entry]) => ({ sessionId, ...entry }))
}

/** 用户点了 ▶ 或发了新消息后删掉这条记录，▶ 不再出现。 */
export function dismissInterruptedTurn(home: string, sessionId: string, now = Date.now()): void {
  const file = path.join(home, 'desktop', STORE_FILE)
  const store = freshStore(readObject(file), now)

  if (sessionId in store) {
    delete store[sessionId]
    writeObject(file, store)
  }
}

export interface InterruptedTurns {
  /** 后端启动前调用；出错只记日志，不挡启动。 */
  claim(home: string): void
  list(): InterruptedTurn[]
  dismiss(sessionId: string): void
}

/** 记住本次运行里启动过后端的账号目录（含 Profile），页面查询时逐个读取。 */
export function createInterruptedTurns(log: (message: string) => void = () => {}): InterruptedTurns {
  const homes = new Set<string>()

  /** 单个目录读写失败不影响其它目录。 */
  function each<T>(action: (home: string) => T[]): T[] {
    return [...homes].flatMap(home => {
      try {
        return action(home)
      } catch (error) {
        log(`[interrupted-turns] ${error instanceof Error ? error.message : String(error)}`)

        return []
      }
    })
  }

  return {
    claim(home) {
      homes.add(home)

      try {
        const found = claimInterruptedTurns(home)

        if (found.length) {
          log(`[interrupted-turns] ${found.length} interrupted turn(s) can be continued`)
        }
      } catch (error) {
        log(`[interrupted-turns] claim failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    list: () => each(home => listInterruptedTurns(home)),
    dismiss(sessionId) {
      each(home => {
        dismissInterruptedTurn(home, sessionId)

        return []
      })
    }
  }
}

/** 页面查询和删除记录的受限接口，只认当前账号的桌面窗口。 */
export function installInterruptedTurnIpc(
  session: Session,
  rendererUrl: () => string,
  active: () => boolean,
  turns: InterruptedTurns
): void {
  /** 与其它账号 IPC 共用来源校验，并要求账号仍处于活动状态。 */
  function trusted(event: IpcMainInvokeEvent): boolean {
    return active() && isDesktopRendererSender(event, session, rendererUrl())
  }

  ipcMain.handle('hermes:interrupted-turns:list', async (event): Promise<InterruptedTurn[]> =>
    trusted(event) ? turns.list() : []
  )

  ipcMain.handle('hermes:interrupted-turns:dismiss', async (event, sessionId: unknown): Promise<void> => {
    if (trusted(event) && typeof sessionId === 'string' && sessionId && sessionId.length <= MAX_SESSION_ID) {
      turns.dismiss(sessionId)
    }
  })
}
