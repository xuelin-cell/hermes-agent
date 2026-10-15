export const ASR_CHANNEL = 'hermes:uniwork-asr'

export interface AsrIdentity {
  owner: string
  key: string
  expiresAt: number
}

export interface AsrTranscript {
  text: string
  final: boolean
}

export interface AsrSnapshot {
  transcripts: AsrTranscript[]
  closed: boolean
  failed: boolean
}

export type AsrRequest =
  | { operation: 'start'; language: 'zh' | 'en' }
  | { operation: 'audio'; id: string; pcm: Uint8Array }
  | { operation: 'poll' | 'stop' | 'cancel'; id: string }

export interface UniworkAsrBridge {
  start(language: 'zh' | 'en'): Promise<string>
  audio(id: string, pcm: Uint8Array): Promise<void>
  poll(id: string): Promise<AsrSnapshot>
  stop(id: string): Promise<AsrSnapshot>
  cancel(id: string): Promise<void>
}
