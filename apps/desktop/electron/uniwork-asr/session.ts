import { randomUUID } from 'node:crypto'

import WebSocket from 'ws'

import type { AsrIdentity, AsrSnapshot, AsrTranscript } from './contract'

const UPSTREAM = 'wss://maas.ai-yuanjing.com/app/uniwork/asr'

/** 元景实时识别连接只由主进程创建，页面不能选择地址或读取鉴权 Key。 */
export class UniworkAsrSession {
  readonly id = randomUUID()
  private readonly socket: WebSocket
  private transcripts: AsrTranscript[] = []
  private closed = false
  private failed = false
  private ending = false
  private readonly expiry: ReturnType<typeof setTimeout>

  /** 固定 PCM16 单声道 16k 协议；注入连接工厂仅用于本地真实 WebSocket 验证。 */
  constructor(
    readonly identity: AsrIdentity,
    private readonly currentIdentity: () => AsrIdentity | null,
    private readonly connect = (url: string, key: string) =>
      new WebSocket(url, {
        headers: { Authorization: `Bearer ${key}` },
        handshakeTimeout: 8_000,
        maxPayload: 256 * 1024,
        followRedirects: false
      })
  ) {
    this.socket = connect(UPSTREAM, identity.key)
    this.expiry = setTimeout(() => this.cancel(), Math.min(5 * 60_000, Math.max(0, identity.expiresAt - Date.now())))
    this.socket.on('error', () => {
      this.failed = true
      this.cancel()
    })
    this.socket.on('close', code => {
      if (!this.ending && !this.closed && code !== 1000) {
        this.failed = true
      }

      this.closed = true
      clearTimeout(this.expiry)
    })
    this.socket.on('message', data => {
      if (!this.authorized()) {
        this.cancel()

        return
      }

      try {
        const value = JSON.parse(data.toString())

        if (value.error || (value.code !== undefined && ![0, '0', 200, '200'].includes(value.code))) {
          this.failed = true
          this.cancel()

          return
        }

        const text = value.result?.text ?? value.text

        if (typeof text === 'string' && text.length <= 16_384) {
          this.transcripts.push({ text, final: Boolean(value.is_endpoint || value.is_end || value.is_final) })

          if (this.transcripts.length > 128) {
            this.failed = true
            this.cancel()
          }
        }
      } catch {
        this.failed = true
        this.cancel()
      }
    })
  }

  /** 查询状态不消费尚未回填的文字。 */
  get isClosed(): boolean {
    return this.closed
  }

  /** 结束时撤销窗口监听，避免重复录音增加常驻回调。 */
  onClosed(callback: () => void): void {
    this.socket.once('close', callback)
  }

  /** 校验当前登录所有者及 Key，过期或切换身份后不继续传输录音。 */
  private authorized(): boolean {
    const current = this.currentIdentity()

    return Boolean(
      current &&
      current.owner === this.identity.owner &&
      current.key === this.identity.key &&
      current.expiresAt > Date.now()
    )
  }

  /** 上游握手完成才发送配置，失败只向页面提供固定安全提示。 */
  async open(language: 'zh' | 'en'): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve)
      this.socket.once('close', () => reject(new Error('语音识别服务连接失败，请稍后重试。')))
      this.socket.once('error', () => reject(new Error('语音识别服务连接失败，请稍后重试。')))
    })

    if (!this.authorized() || this.closed) {
      this.cancel()
      throw new Error('请重新登录后使用语音识别。')
    }

    this.socket.send(
      JSON.stringify({
        config: {
          samp_freq: 16000,
          language,
          diarization: 1,
          add_punc: 1,
          if_written: 1
        }
      })
    )
  }

  /** 限制单帧及积压大小，防止采集速度超过网络时无限缓存音频。 */
  audio(pcm: Uint8Array): void {
    if (!this.authorized() || this.ending || this.closed || this.socket.readyState !== WebSocket.OPEN) {
      this.cancel()
      throw new Error('语音识别连接已结束。')
    }

    if (
      !(pcm instanceof Uint8Array) ||
      !pcm.byteLength ||
      pcm.byteLength > 32_768 ||
      pcm.byteLength % 2 ||
      this.socket.bufferedAmount > 512 * 1024
    ) {
      this.cancel()
      throw new Error('语音识别音频传输失败，请重试。')
    }

    this.socket.send(pcm)
  }

  /** 只返回识别结果和状态，不让页面取得连接或服务端原始异常。 */
  poll(): AsrSnapshot {
    if (!this.authorized()) {
      this.failed = true
      this.cancel()
    }

    return { transcripts: this.transcripts.splice(0), closed: this.closed, failed: this.failed }
  }

  /** EOF 后保留短暂收尾窗口，接收最后一句文字后再释放连接。 */
  async stop(): Promise<AsrSnapshot> {
    this.ending = true

    if (!this.closed && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ eof: 1 }))
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          this.socket.off('close', finish)
          resolve()
        }, 1_500)

        /** 上游提前结束时取消收尾等待，避免固定延迟。 */
        const finish = () => {
          clearTimeout(timer)
          resolve()
        }

        this.socket.once('close', finish)
      })
    }

    this.cancel()

    return this.poll()
  }

  /** 窗口关闭、导航或取消立即释放连接；识别文本不写入磁盘日志。 */
  cancel(): void {
    clearTimeout(this.expiry)
    this.closed = true
    this.socket.terminate()
  }
}
