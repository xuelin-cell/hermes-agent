import { useAuiState } from '@assistant-ui/react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { formatTurnTokenCount, parseTurnTokenUsage } from '@/lib/turn-token-usage'

export function TurnTokenUsage() {
  const usage = useAuiState(s => s.message.metadata?.custom?.turnTokenUsage)
  const { locale, t } = useI18n()
  const tokens = parseTurnTokenUsage(usage)

  if (!tokens) {
    return null
  }

  const exact = new Intl.NumberFormat(locale)

  const label = t.assistant.thread.turnTokenUsage(
    exact.format(tokens.input_tokens),
    exact.format(tokens.output_tokens),
    exact.format(tokens.total_tokens)
  )

  return (
    <Tip label={<span className="whitespace-pre-line">{label}</span>}>
      <span
        aria-label={label}
        className="inline-flex select-none items-center gap-1 whitespace-nowrap text-xs font-normal leading-none tabular-nums text-muted-foreground"
        data-slot="aui_turn-token-usage"
        tabIndex={0}
      >
        <span
          className="font-medium text-[color-mix(in_srgb,var(--ui-text-secondary)_45%,var(--muted-foreground))]"
          data-slot="aui_turn-token-count"
        >
          {formatTurnTokenCount(tokens.total_tokens, locale)}
        </span>
        <span>{t.assistant.thread.tokenUnit}</span>
      </span>
    </Tip>
  )
}
