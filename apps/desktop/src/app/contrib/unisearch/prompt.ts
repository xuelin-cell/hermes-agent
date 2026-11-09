import { getToolsetConfig } from '@/api/toolsets'
import { referenceRe } from '@/components/assistant-ui/reference-kinds'
import { withTimeout } from '@/lib/with-timeout'
import type { SessionOwnerRoute } from '@/store/session-request-router'

const pending = new Map<string, Set<AbortController>>()

/** 只按完整owner与会话定位等待中的发送，不借用当前窗口身份。 */
function pendingKey(owner: SessionOwnerRoute, params: Record<string, unknown>): string | null {
  return typeof params.session_id === 'string' && params.session_id
    ? JSON.stringify([owner.connectionId.trim(), owner.profile.trim() || 'default', params.session_id])
    : null
}

/** 停止或关闭会话时撤销尚未发送的网址请求，不让迟到的配置响应重新发出消息。 */
export function cancelPendingWebPrompts(owner: SessionOwnerRoute, params: Record<string, unknown>): void {
  const key = pendingKey(owner, params)

  if (key) {
    pending.get(key)?.forEach(controller => controller.abort())
  }
}

/** 仅识别网址引用；普通网址及文件等引用不增加能力查询。 */
export function hasWebPreRead(method: string, params: Record<string, unknown>): boolean {
  return (
    method === 'prompt.submit' &&
    typeof params.text === 'string' &&
    [...params.text.matchAll(referenceRe())].some(match => match[1] === 'url')
  )
}

/** Builtin只保留原网址，让现有工具按任务读取并携带完整质量状态。 */
export function deferBuiltinWebReferences(text: string): string {
  return text.replace(referenceRe(), (match, kind: string, value: string) => {
    if (kind !== 'url') {return match}

    // 移除外层引用后不能让网址内部的字符串变成新的文件或插件上下文引用。
    if (/@(?:[\w-]+:|diff\b|staged\b)/.test(value)) {
      throw new Error('该网址包含无法安全读取的内容，请检查后再发送。')
    }

    return value
  })
}

/** 固定会话owner后查实际抓取后端，不读取当前窗口的默认配置。 */
export async function prepareWebPrompt(
  params: Record<string, unknown>,
  owner: SessionOwnerRoute,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const key = pendingKey(owner, params)
  const abort = () => controller.abort()

  signal?.addEventListener('abort', abort, { once: true })

  if (key) {
    const set = pending.get(key) ?? new Set<AbortController>()
    set.add(controller)
    pending.set(key, set)
  }

  let rejectCancelled!: () => void

  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = () => reject(new DOMException('Request cancelled', 'AbortError'))
    controller.signal.addEventListener('abort', rejectCancelled, { once: true })
  })

  try {
    const config = await withTimeout(
      Promise.race([
        getToolsetConfig('web', { connectionId: owner.connectionId, profile: owner.profile }),
        cancelled
      ]),
      5000,
      '无法确认当前会话的网页读取方式，请稍后重试。'
    )

    controller.signal.throwIfAborted()

    if (config.active_extract_backend !== 'builtin_parse' || typeof params.text !== 'string') {
      return params
    }

    return { ...params, text: deferBuiltinWebReferences(params.text) }
  } finally {
    signal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', rejectCancelled)

    if (key) {
      pending.get(key)?.delete(controller)

      if (!pending.get(key)?.size) {
        pending.delete(key)
      }
    }
  }
}
