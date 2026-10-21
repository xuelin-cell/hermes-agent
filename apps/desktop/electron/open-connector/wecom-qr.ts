import { randomUUID } from 'node:crypto'

import QRCode from 'qrcode'

interface QrSession {
  profile: string
  scode: string
  expires: number
}
export interface WecomQrResult {
  sessionId: string
  qrImage?: string
  qrState: 'pending' | 'scanned' | 'confirmed' | 'expired'
}

/** Port of HexAgent's official WeCom CLI flow; bot secrets never reach the renderer. */
export class WecomQrSessions {
  private sessions = new Map<string, QrSession>()
  private closed = false

  async start(profile: string): Promise<WecomQrResult> {
    this.cancelProfile(profile)
    const platform = { darwin: 1, win32: 2, linux: 3 }[process.platform] || 0

    const result = await this.get(
      `https://work.weixin.qq.com/ai/qc/generate?source=wecom_cli_external&plat=${platform}`
    )
    if (this.closed) throw new Error('WeCom QR authorization has been closed')

    if (typeof result.scode !== 'string' || !result.scode || typeof result.auth_url !== 'string') {
      throw new Error('企业微信未返回有效二维码')
    }

    const url = new URL(result.auth_url)

    if (url.protocol !== 'https:' || url.hostname !== 'work.weixin.qq.com') {
      throw new Error('Invalid WeCom QR URL')
    }

    const sessionId = randomUUID()
    this.sessions.set(sessionId, { profile, scode: result.scode, expires: Date.now() + 300_000 })

    return { sessionId, qrState: 'pending', qrImage: await QRCode.toDataURL(url.href, { width: 240, margin: 2 }) }
  }

  async poll(profile: string, sessionId: string): Promise<{ result: WecomQrResult; values?: Record<string, string> }> {
    const session = this.sessions.get(sessionId)

    if (!session || session.profile !== profile) {
      throw new Error('Invalid WeCom QR session')
    }

    if (Date.now() > session.expires) {
      this.sessions.delete(sessionId)

      return { result: { sessionId, qrState: 'expired' } }
    }

    const data = await this.get(
      `https://work.weixin.qq.com/ai/qc/query_result?scode=${encodeURIComponent(session.scode)}`
    )

    if (this.sessions.get(sessionId) !== session) {
      throw new Error('WeCom QR session cancelled')
    }

    const status = String(data.status || '').toLowerCase()

    if (['expired', 'timeout', 'cancelled', 'canceled'].includes(status)) {
      this.sessions.delete(sessionId)

      return { result: { sessionId, qrState: 'expired' } }
    }

    if (status === 'success') {
      const botId = data.bot_info?.botid,
        secret = data.bot_info?.secret

      if (typeof botId !== 'string' || !botId || typeof secret !== 'string' || !secret) {
        throw new Error('扫码成功但未返回机器人信息')
      }

      this.sessions.delete(sessionId)

      return { result: { sessionId, qrState: 'confirmed' }, values: { botId, secret } }
    }

    return { result: { sessionId, qrState: status === 'scanned' ? 'scanned' : 'pending' } }
  }

  cancelProfile(profile: string): void {
    for (const [id, session] of this.sessions) {
      if (session.profile === profile || session.expires < Date.now()) {
        this.sessions.delete(id)
      }
    }
  }

  close(): void {
    this.closed = true
    this.sessions.clear()
  }

  private async get(url: string): Promise<Record<string, any>> {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' })

    if (!response.ok) {
      throw new Error(`企业微信授权服务返回 HTTP ${response.status}`)
    }

    const payload = await response.json()

    if (!payload || typeof payload.data !== 'object' || !payload.data) {
      throw new Error('企业微信授权服务返回格式异常')
    }

    return payload.data
  }
}
