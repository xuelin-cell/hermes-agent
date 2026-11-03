import type { NtfyEvent, NtfyStatus } from '../../electron/uniwork-notify/contract'
import type { AsrSnapshot } from '../../electron/uniwork-asr/contract'
import { readBrowserAuth, requestEntryMaas } from '../../../shared/src/browser-maas-auth.js'

/** Poll through fixed same-origin operations; stale account results never reach the page. */
export function browserAccount(base: string) {
  const listeners = new Set<(event: NtfyEvent) => void>()
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let active = false
  let subscriptionOwner: string | null = null
  let cursor = 0
  const call = <T>(operation: string, body: object = {}) => requestEntryMaas<T>(base, `account/${operation}`, {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  const owner = () => readBrowserAuth(base)?.loginId ?? null
  async function poll(generation: number, login: string | null) {
    if (!active || epoch !== generation || owner() !== login) return
    try {
      const result = await call<{ events: NtfyEvent[]; cursor: number }>('notify-poll', { cursor })
      if (!active || epoch !== generation || owner() !== login) return
      cursor = result.cursor
      for (const event of result.events) for (const listener of listeners) listener(event)
    } catch { /* A failed read backs off; it never changes account state. */ }
    if (active && epoch === generation && owner() === login) timer = setTimeout(() => void poll(generation, login), 3000)
  }
  const speechOwner = new Map<string, string | null>()
  async function speech<T>(action: string, id: string, body: object = {}) {
    if (!speechOwner.has(id) || speechOwner.get(id) !== owner()) throw Error('语音会话已结束。')
    const result = await call<T>(action, { session: id, ...body })
    if (speechOwner.get(id) !== owner()) throw Error('账号已切换。')
    return result
  }
  return {
    ntfy: {
      scope: owner,
      onEvent(listener: (event: NtfyEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      async start(): Promise<NtfyStatus> {
        const generation = ++epoch
        clearTimeout(timer)
        const login = owner()
        subscriptionOwner = login
        cursor = 0
        const status = await call<NtfyStatus>('notify-start')
        if (generation !== epoch || login !== owner()) return { state: 'stopped' }
        active = true
        void poll(generation, login)
        return status
      },
      async stop(): Promise<NtfyStatus> {
        active = false
        epoch++
        clearTimeout(timer)
        if (owner() === subscriptionOwner) await call('notify-stop').catch(() => undefined)
        subscriptionOwner = null
        return { state: 'stopped' }
      },
      refresh: () => call<{ status: 'ok' | 'failed' | 'skipped' }>('notify-refresh')
    },
    uniworkAsr: {
      async start(language: 'zh' | 'en') {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Error('请通过 HTTPS 打开页面后使用麦克风。')
        const login = owner()
        const id = await call<string>('asr-start', { language })
        if (login !== owner()) throw Error('账号已切换。')
        speechOwner.set(id, login)
        return id
      },
      async audio(id: string, pcm: Uint8Array) {
        if (!pcm.byteLength || pcm.byteLength > 32768 || pcm.byteLength % 2) throw Error('音频帧无效。')
        let raw = ''
        for (const byte of pcm) raw += String.fromCharCode(byte)
        await speech('asr-audio', id, { pcm: btoa(raw) })
      },
      poll: (id: string) => speech<AsrSnapshot>('asr-poll', id),
      async stop(id: string) { try { return await speech<AsrSnapshot>('asr-stop', id) } finally { speechOwner.delete(id) } },
      async cancel(id: string) { try { await speech('asr-cancel', id) } finally { speechOwner.delete(id) } }
    }
  }
}
