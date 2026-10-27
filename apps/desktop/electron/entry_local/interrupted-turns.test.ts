import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
const fromDesktop = vi.hoisted(() => ({ value: true }))

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) }
}))
// 来源校验本身另有测试，这里只控制它的结果。
vi.mock('../desktop-renderer-sender', () => ({ isDesktopRendererSender: () => fromDesktop.value }))

import {
  claimInterruptedTurns,
  createInterruptedTurns,
  dismissInterruptedTurn,
  installInterruptedTurnIpc,
  listInterruptedTurns,
  RESUME_WINDOW_MS
} from './interrupted-turns'

const NOW = 1_800_000_000_000
const dead = () => false

let home: string

/** 按 Hermes 的格式写一份中断记录。 */
function writeMarkers(entries: Record<string, unknown>): void {
  fs.mkdirSync(path.join(home, 'desktop'), { recursive: true })
  fs.writeFileSync(path.join(home, 'desktop', 'interrupted_turns.json'), JSON.stringify(entries))
}

/** 读回 Hermes 的中断记录；文件被删掉时返回 null。 */
function readMarkers(): null | Record<string, unknown> {
  const file = path.join(home, 'desktop', 'interrupted_turns.json')

  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

beforeEach(() => {
  handlers.clear()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-interrupted-'))
})

afterEach(() => {
  if (path.dirname(home) !== os.tmpdir() || !path.basename(home).startsWith('hermes-interrupted-')) {
    throw new Error('Unsafe cleanup')
  }

  fs.rmSync(home, { recursive: true, force: true })
})

describe('后端启动前接手中断记录', () => {
  it('把写记录的进程已不在的那一轮搬过来，Hermes 那边删掉，就不会自动续跑', () => {
    writeMarkers({
      s1: { prompt: '整理报告', started_at: 1, attempts: 0, auto_continue: true, writer_pid: 999_999 }
    })

    expect(claimInterruptedTurns(home, NOW, dead)).toEqual([{ sessionId: 's1', prompt: '整理报告', detectedAt: NOW }])
    expect(readMarkers()).toBeNull()
    expect(listInterruptedTurns(home, NOW + 1)).toEqual([{ sessionId: 's1', prompt: '整理报告', detectedAt: NOW }])
  })

  it('别的后端还在跑、导入的回合、空请求都原样留给 Hermes', () => {
    const live = { prompt: '还在跑', writer_pid: 1 }
    const imported = { prompt: '导入', auto_continue: false }
    const blank = { prompt: '  ' }
    writeMarkers({ live, imported, blank })

    expect(claimInterruptedTurns(home, NOW, entry => entry.writer_pid === 1)).toEqual([])
    expect(readMarkers()).toEqual({ live, imported, blank })
  })

  it('15 分钟从发现时算起；再次启动不会重新计时', () => {
    writeMarkers({ s1: { prompt: '任务' } })
    claimInterruptedTurns(home, NOW, dead)

    // 期间又重启一次：记录已经搬走，发现时间保持第一次的。
    expect(claimInterruptedTurns(home, NOW + 60_000, dead)).toEqual([
      { sessionId: 's1', prompt: '任务', detectedAt: NOW }
    ])
    expect(listInterruptedTurns(home, NOW + RESUME_WINDOW_MS - 1)).toHaveLength(1)
    expect(listInterruptedTurns(home, NOW + RESUME_WINDOW_MS)).toEqual([])
    claimInterruptedTurns(home, NOW + RESUME_WINDOW_MS, dead)
    expect(fs.existsSync(path.join(home, 'desktop', 'uniwork-interrupted-turns.json'))).toBe(false)
  })

  it('用户处理过的会话删掉记录，其它会话不受影响', () => {
    writeMarkers({ s1: { prompt: '一' }, s2: { prompt: '二' } })
    claimInterruptedTurns(home, NOW, dead)
    dismissInterruptedTurn(home, 's1', NOW + 1)

    expect(listInterruptedTurns(home, NOW + 2).map(turn => turn.sessionId)).toEqual(['s2'])
  })

  it('记录文件损坏时当作没有，不挡后端启动', () => {
    fs.mkdirSync(path.join(home, 'desktop'), { recursive: true })
    fs.writeFileSync(path.join(home, 'desktop', 'interrupted_turns.json'), '{坏')

    expect(claimInterruptedTurns(home, NOW, dead)).toEqual([])
  })
})

describe('页面接口', () => {
  it('只回答当前账号的桌面窗口，并能删掉记录', async () => {
    writeMarkers({ s1: { prompt: '任务', writer_pid: 2_147_483_000 } })
    const turns = createInterruptedTurns()
    turns.claim(home)
    let active = true
    fromDesktop.value = true
    installInterruptedTurnIpc({} as never, () => 'app://renderer', () => active, turns)
    const list = handlers.get('hermes:interrupted-turns:list')!
    const dismiss = handlers.get('hermes:interrupted-turns:dismiss')!

    expect((await list({})).map((turn: { prompt: string }) => turn.prompt)).toEqual(['任务'])

    // 别的窗口或已退出的账号：查不到，也删不掉。
    fromDesktop.value = false
    expect(await list({})).toEqual([])
    await dismiss({}, 's1')
    fromDesktop.value = true
    active = false
    await dismiss({}, 's1')
    active = true
    expect(turns.list()).toHaveLength(1)

    await dismiss({}, 's1')
    expect(await list({})).toEqual([])
  })
})
