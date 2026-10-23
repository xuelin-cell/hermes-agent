import type { ChatMessage } from './types'

/** 更新已存在工具的执行状态；不创建结果、不改变消息归属，也不重开已结束的工具。 */
export function markToolExecutionFinished(messages: ChatMessage[], toolId: string, occurredAt: number): ChatMessage[] {
  let changed = false
  const next = messages.map(message => {
    let messageChanged = false
    const parts = message.parts.map(part => {
      if (
        part.type !== 'tool-call' ||
        part.toolCallId !== toolId ||
        part.completedAt !== undefined ||
        part.result !== undefined ||
        part.interrupted ||
        part.toolResultMetadata?.execution_finished_at !== undefined
      ) {
        return part
      }
      messageChanged = true
      return { ...part, toolResultMetadata: { ...part.toolResultMetadata, execution_finished_at: occurredAt } }
    })
    changed ||= messageChanged
    return messageChanged ? { ...message, parts } : message
  })
  return changed ? next : messages
}
