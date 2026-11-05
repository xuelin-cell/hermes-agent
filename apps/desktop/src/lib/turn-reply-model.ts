import type { TurnReplyModel } from '@hermes/shared'

export function parseTurnReplyModel(value: unknown): TurnReplyModel | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const record = value as Record<string, unknown>
  const model = typeof record.model === 'string' ? record.model.trim() : ''

  return model
    ? {
        model,
        name: typeof record.name === 'string' ? record.name.trim() : '',
        provider: typeof record.provider === 'string' ? record.provider.trim() : ''
      }
    : undefined
}
