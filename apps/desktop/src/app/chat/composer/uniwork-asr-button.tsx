import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { iconSize, Loader2, Mic, Square } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { ACTIVE_ICON_BTN, GHOST_ICON_BTN } from './control-classes'

interface UniworkAsrButtonProps {
  status: 'idle' | 'connecting' | 'recording' | 'finishing'
  disabled: boolean
  onToggle: () => void
}

/** 普通模式直接使用元景实时识别；忙碌状态仍保留停止录音入口。 */
export function UniworkAsrButton({ status, disabled, onToggle }: UniworkAsrButtonProps) {
  const { t } = useI18n()
  const active = status !== 'idle'
  const label = active ? t.composer.stopRecognition : t.composer.startRecognition

  return (
    <Tip label={label} placement="control">
      <Button
        aria-label={label}
        aria-pressed={active}
        className={cn(GHOST_ICON_BTN, active && ACTIVE_ICON_BTN)}
        disabled={status === 'finishing' || (disabled && !active)}
        onClick={onToggle}
        size="icon"
        type="button"
        variant="ghost"
      >
        {status === 'connecting' || status === 'finishing' ? (
          <Loader2 className={cn(iconSize.sm, 'animate-spin')} />
        ) : active ? (
          <Square className={cn(iconSize.xs, 'fill-current')} />
        ) : (
          <Mic className={iconSize.sm} />
        )}
      </Button>
    </Tip>
  )
}
