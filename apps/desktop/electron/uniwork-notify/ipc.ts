import { ipcMain, powerMonitor, type Session, type WebContents } from 'electron'

import { isDesktopRendererSender } from '../desktop-renderer-sender'
import type { LoginIdentity } from '../login/session'

import {
  NTFY_EVENT_CHANNEL,
  NTFY_REFRESH_CHANNEL,
  NTFY_START_CHANNEL,
  NTFY_STOP_CHANNEL,
  type NtfyEvent,
  type NtfyRefreshResult,
  type NtfyStatus
} from './contract'
import { NtfySubscriber } from './subscriber'
import { NtfyTokenClient } from './token'

export interface NtfyIpcOptions {
  identity: () => LoginIdentity | null
  log: (line: string) => void
  refresh: () => Promise<NtfyRefreshResult>
}

/**
 * 一条连接服务整个应用：窗口只是订阅者，关掉最后一个窗口才断开。
 * 这样多窗口/多标签不会重复占用服务端订阅配额（F6/N3）。
 */
export function installNtfyIpc(session: Session, rendererUrl: () => string, options: NtfyIpcOptions): void {
  const tokens = new NtfyTokenClient(options.identity, { log: options.log })
  const listeners = new Map<number, WebContents>()
  let subscriber: NtfySubscriber | null = null

  const send = (event: NtfyEvent) => {
    for (const [id, target] of listeners) {
      if (target.isDestroyed()) {
        listeners.delete(id)

        continue
      }

      target.send(NTFY_EVENT_CHANNEL, event)
    }
  }

  const ensureSubscriber = (): NtfySubscriber => {
    if (subscriber) {
      return subscriber
    }

    subscriber = new NtfySubscriber({
      identity: options.identity,
      log: options.log,
      onAnnouncement: announcement => send({ announcement, kind: 'announcement' }),
      onInstruction: instruction => send({ instruction, kind: 'instruction' }),
      onStatus: status => send({ kind: 'status', status }),
      tokens
    })

    return subscriber
  }

  const currentStatus = (): NtfyStatus => subscriber?.statusSnapshot() ?? { state: 'stopped' }

  const trusted = (event: Electron.IpcMainInvokeEvent, args: unknown[]): boolean =>
    !args.length && isDesktopRendererSender(event, session, rendererUrl())

  ipcMain.handle(NTFY_START_CHANNEL, (event, ...args): NtfyStatus => {
    if (!trusted(event, args)) {
      return { state: 'stopped' }
    }

    const id = event.sender.id

    if (!listeners.has(id)) {
      listeners.set(id, event.sender)
      event.sender.once('destroyed', () => listeners.delete(id))
    }

    const active = ensureSubscriber()
    active.start()

    return active.statusSnapshot()
  })

  ipcMain.handle(NTFY_STOP_CHANNEL, (event, ...args): NtfyStatus => {
    if (!trusted(event, args)) {
      return currentStatus()
    }

    listeners.delete(event.sender.id)

    if (listeners.size === 0) {
      subscriber?.stop()
    }

    return currentStatus()
  })

  ipcMain.handle(NTFY_REFRESH_CHANNEL, async (event, ...args): Promise<NtfyRefreshResult> => {
    if (!trusted(event, args)) {
      return { status: 'skipped' }
    }

    return options.refresh()
  })

  // 系统唤醒后立刻重连，不等当前退避走完（F5 最后一行）。
  powerMonitor.on('resume', () => subscriber?.retryNow())
}
