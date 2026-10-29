/**
 * SSE 帧解析：只做协议层的事（分帧、取 `data:`），业务分发放到订阅器。
 * 服务端每帧是一个单行 JSON，控制帧（`event: open` / `keepalive`）由调用方忽略。
 */
export function createSseParser(onData: (payload: string) => void) {
  let buffer = ''

  const drain = () => {
    // 统一换行后再找空行边界；数据行本身不允许含换行，所以不会破坏 JSON。
    buffer = buffer.replace(/\r\n/g, '\n')

    for (let boundary = buffer.indexOf('\n\n'); boundary >= 0; boundary = buffer.indexOf('\n\n')) {
      const frame = buffer.slice(0, boundary)

      buffer = buffer.slice(boundary + 2)

      const data = frame
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(line.startsWith('data: ') ? 6 : 5))
        .join('\n')

      if (data) {
        onData(data)
      }
    }
  }

  return {
    /** 喂入一段已解码的文本，按完整帧回调。 */
    push(chunk: string) {
      buffer += chunk
      drain()
    }
  }
}

/** 频道名只允许小写字母、数字、下划线、短横线；组装后必须去重。 */
export function ntfyTopics(phone: string | undefined): string[] {
  const topics = ['uniwork']

  if (phone && /^\d{6,20}$/.test(phone)) {
    // 点对点频道由 uniclaw_ 迁移到 uniwork_，过渡期两个都订阅。
    topics.push(`uniwork_${phone}`, `uniclaw_${phone}`)
  }

  return [...new Set(topics)]
}

/** 订阅地址；凭证只走请求头，绝不进 URL。 */
export function ntfyStreamUrl(topics: readonly string[], since: string): string {
  return `https://maas.ai-yuanjing.com/app/ntfy/${topics.join(',')}/sse?since=${encodeURIComponent(since)}`
}

/**
 * 回填窗口：首次连接补 12 小时；重连只补真正错过的那段（<1 分钟用 1m，
 * <1 小时用 Nm，否则用 Nh）。
 */
export function sinceWindow(lastMessageAt: number | null, now: number): string {
  if (lastMessageAt === null) {
    return '12h'
  }

  const elapsed = Math.max(0, now - lastMessageAt)

  if (elapsed < 60_000) {
    return '1m'
  }

  if (elapsed < 3_600_000) {
    return `${Math.ceil(elapsed / 60_000)}m`
  }

  return `${Math.ceil(elapsed / 3_600_000)}h`
}

/** 频道名含手机号，日志与状态里一律打码。 */
export function maskTopic(topic: string): string {
  const match = /^(uniwork|uniclaw)_(\d{3})\d+(\d{4})$/.exec(topic)

  return match ? `${match[1]}_${match[2]}****${match[3]}` : topic
}
