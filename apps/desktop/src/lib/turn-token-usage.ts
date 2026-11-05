import type { TurnTokenUsage } from '@hermes/shared'

/** Match Uniwork footers: fixed K/M suffixes, up to two decimals and no trailing zeroes. */
export function formatTurnTokenCount(value: number, locale: string): string {
  const count = Math.max(0, Math.round(value))

  if (count >= 1_000_000) {
    return `${Number((count / 1_000_000).toFixed(2))}M`
  }

  if (count >= 1_000) {
    return `${Number((count / 1_000).toFixed(2))}K`
  }

  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(count)
}

/** Usage crosses both live events and older transcript metadata, so validate at either boundary. */
export function parseTurnTokenUsage(value: unknown): TurnTokenUsage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const usage = value as TurnTokenUsage

  const counts = [
    usage.input_tokens,
    usage.output_tokens,
    usage.total_tokens,
    usage.cache_read_tokens,
    usage.cache_write_tokens
  ]

  return counts.every(count => Number.isSafeInteger(count) && count >= 0) && usage.total_tokens > 0 ? usage : undefined
}
