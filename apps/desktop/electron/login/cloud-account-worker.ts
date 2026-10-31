/** Private Entry worker: reuse desktop notification and speech protocols. */
import { createInterface } from 'node:readline'

import type { LoginIdentity } from './session'
import type { AsrIdentity } from '../uniwork-asr/contract'
import { UniworkAsrSession } from '../uniwork-asr/session'
import { NtfySubscriber } from '../uniwork-notify/subscriber'
import { NtfyTokenClient } from '../uniwork-notify/token'
import type { NtfyEvent } from '../uniwork-notify/contract'

interface Account {
  identity: LoginIdentity
  events: { sequence: number; event: NtfyEvent }[]
  subscriber: NtfySubscriber
  speech?: UniworkAsrSession
  speechIdentity?: AsrIdentity
  sequence: number
  until: number
}
interface Input {
  id: string
  key: string
  action: string
  identity?: LoginIdentity
  apiKey?: string
  language?: 'zh' | 'en'
  session?: string
  pcm?: string
  cursor?: number
}

const accounts = new Map<string, Account>()
function close(key: string) {
  const account = accounts.get(key)
  account?.subscriber.stop()
  account?.speech?.cancel()
  accounts.delete(key)
}
function accountFor(input: Input): Account {
  const identity = input.identity
  if (!identity?.uid || !identity.token || identity.expiresAt <= Date.now() || !input.key) throw Error('auth')
  let account = accounts.get(input.key)
  if (account && (account.identity.uid !== identity.uid || account.identity.token !== identity.token)) {
    close(input.key)
    account = undefined
  }
  if (!account) {
    if (accounts.size >= 512) throw Error('busy')
    const events: { sequence: number; event: NtfyEvent }[] = []
    const current = () => accounts.get(input.key)?.identity ?? null
    const emit = (event: NtfyEvent) => { const state = accounts.get(input.key); if (!state) return; events.push({ sequence: ++state.sequence, event }); if (events.length > 200) events.shift() }
    const subscriber = new NtfySubscriber({ identity: current, tokens: new NtfyTokenClient(current),
      onAnnouncement: announcement => emit({ kind: 'announcement', announcement }),
      onInstruction: instruction => emit({ kind: 'instruction', instruction }),
      onStatus: status => emit({ kind: 'status', status }) })
    account = { identity, events, subscriber, sequence: 0, until: 0 }
    accounts.set(input.key, account)
  }
  account.identity = identity
  account.until = Math.min(identity.expiresAt, Date.now() + 90_000)
  return account
}

export async function handleAccount(input: Input) {
  if (input.action === 'logout') { close(input.key); return { ok: true } }
  const account = accountFor(input)
  const actions: Record<string, () => unknown> = {
    'notify-start': () => { account.subscriber.start(); return account.subscriber.statusSnapshot() },
    'notify-poll': () => ({ events: account.events.filter(item => item.sequence > (input.cursor ?? 0)).map(item => item.event), cursor: account.sequence }),
    'notify-stop': () => { account.subscriber.stop(); return account.subscriber.statusSnapshot() },
    'asr-start': async () => {
      if (!['zh', 'en'].includes(input.language ?? '') || !input.apiKey) throw Error('invalid_speech_request')
      if (account.speech && !account.speech.isClosed) throw Error('speech_in_use')
      const identity = { owner: input.key, key: input.apiKey, expiresAt: input.identity!.expiresAt }
      account.speechIdentity = identity
      const speech = new UniworkAsrSession(identity, () => accounts.get(input.key)?.speechIdentity ?? null)
      account.speech = speech
      try { await speech.open(input.language!); return speech.id }
      catch { speech.cancel(); throw Error('speech_unavailable') }
    }
  }
  if (actions[input.action]) return actions[input.action]!()
  const speech = account.speech
  if (!speech || speech.id !== input.session) throw Error('speech_ended')
  const speechActions: Record<string, () => unknown> = {
    'asr-audio': () => { speech.audio(Buffer.from(input.pcm ?? '', 'base64')); return { ok: true } },
    'asr-poll': () => speech.poll(),
    'asr-stop': () => speech.stop(),
    'asr-cancel': () => { speech.cancel(); return { ok: true } }
  }
  if (!speechActions[input.action]) throw Error('invalid_action')
  return speechActions[input.action]!()
}

export function startAccountWorker() {
  const timer = setInterval(() => {
    for (const [key, account] of accounts) if (account.until <= Date.now()) close(key)
  }, 10_000)
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => {
    void (async () => {
      let input: Input
      try { input = JSON.parse(line) }
      catch { return }
      try { process.stdout.write(JSON.stringify({ id: input.id, result: await handleAccount(input) }) + '\n') }
      catch { process.stdout.write(JSON.stringify({ id: input.id, result: { error: '账号通知或语音服务暂时不可用，请重试。' } }) + '\n') }
    })()
  })
  lines.on('close', () => { clearInterval(timer); for (const key of accounts.keys()) close(key) })
}
startAccountWorker()
