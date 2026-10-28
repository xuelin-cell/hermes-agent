import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'

import { PRIMARY_ICON_BTN } from '../control-classes'

import { useInterruptedCopy } from './copy'

/** 输入框空着且有可续跑的中断回答时，代替发送键的 ▶ 按钮。 */
export function ContinueInterruptedButton({ disabled, onContinue }: { disabled: boolean; onContinue: () => void }) {
  const copy = useInterruptedCopy()

  return (
    <Tip label={copy('continue')} placement="control">
      <Button
        aria-label={copy('continue')}
        className={PRIMARY_ICON_BTN}
        data-testid="continue-interrupted"
        disabled={disabled}
        onClick={onContinue}
        type="button"
      >
        <Codicon name="play" size="0.875rem" />
      </Button>
    </Tip>
  )
}
