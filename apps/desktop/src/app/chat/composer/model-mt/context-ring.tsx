import { ContextUsagePanel } from '@/app/shell/context-usage-panel'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'

import { formatContextTokens } from './context-usage'
import { useComposerModelCopy } from './copy'
import { type ComposerContextProps, useComposerContextUsage } from './use-context-usage'

/** 用紧凑圆环展示当前窗格用量，点击复用原版分类明细。 */
export function ComposerContextRing(props: ComposerContextProps) {
  const t = useComposerModelCopy()
  const { context, breakdown, loading, usage } = useComposerContextUsage(props)

  if (!context) {
    return null
  }

  const prefix = context.estimated ? '~' : ''
  const percent = `${prefix}${context.percent.toFixed(1)}`
  const used = `${prefix}${formatContextTokens(context.used)}`
  const max = formatContextTokens(context.max)
  const circumference = 2 * Math.PI * 11.5

  return (
    <Popover>
      <Tip label={t('contextTooltip', percent, used, max)}>
        <PopoverTrigger asChild>
          <Button aria-label={t('contextAria', percent, used, max)} size="icon-sm" variant="ghost">
            <svg
              aria-hidden="true"
              style={{ width: 18, height: 18, transform: 'rotate(-90deg)', color: 'var(--ui-text-tertiary)' }}
              viewBox="0 0 32 32"
            >
              <circle cx="16" cy="16" fill="none" r="11.5" stroke="var(--ui-stroke-tertiary)" strokeWidth="3.5" />
              <circle
                cx="16"
                cy="16"
                fill="none"
                r="11.5"
                stroke="currentColor"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - context.progress / 100)}
                strokeLinecap="round"
                strokeWidth="3.5"
              />
            </svg>
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-auto p-0" side="top">
        <ContextUsagePanel breakdown={breakdown} loading={loading} usage={usage} />
      </PopoverContent>
    </Popover>
  )
}
