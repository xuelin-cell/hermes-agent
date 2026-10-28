import { useStore } from '@nanostores/react'
import { Hand, ShieldAlert, TerminalSquare } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { StatusbarItem } from '@/app/shell/statusbar-controls'
import { DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  $approvalModes,
  type ApprovalMode,
  type ApprovalModeRequester,
  setApprovalModeForProfile,
  syncApprovalModeForProfile
} from '@/store/approval-mode'
import { notifyError } from '@/store/notifications'

import { useApprovalModeCopy } from './approval-mode-copy'

const MODE_ICONS = { manual: Hand, smart: TerminalSquare, off: ShieldAlert }

function ApprovalModeOptions({ mode, onSelect }: { mode: ApprovalMode; onSelect: (mode: ApprovalMode) => void }) {
  const copy = useApprovalModeCopy()
  const [helpOpen, setHelpOpen] = useState(false)

  return (
    <>
      <div className="flex items-center justify-between gap-4 px-3 pb-2 pt-2">
        <DropdownMenuLabel className="p-0 text-sm font-normal text-muted-foreground">{copy('title')}</DropdownMenuLabel>
        <button
          aria-expanded={helpOpen}
          className="shrink-0 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          onClick={() => setHelpOpen(!helpOpen)}
          type="button"
        >
          {copy('learnMore')}
        </button>
      </div>
      {helpOpen && <p className="px-3 pb-3 text-xs leading-relaxed text-muted-foreground">{copy('help')}</p>}
      <DropdownMenuRadioGroup onValueChange={value => onSelect(value as ApprovalMode)} value={mode}>
        {(['manual', 'smart', 'off'] as const).map(value => {
          const Icon = MODE_ICONS[value]
          const full = value === 'off'

          return (
            <DropdownMenuRadioItem
              className={cn(
                'items-center gap-3 rounded-xl px-3 py-2.5',
                full && 'text-(--ui-accent) focus:text-(--ui-accent) data-[highlighted]:text-(--ui-accent) [&>span:last-child]:text-(--ui-accent)'
              )}
              key={value}
              value={value}
            >
              <Icon aria-hidden="true" className="size-5 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{copy(value)}</span>
                <span className={cn('text-xs leading-snug', full ? 'text-(--ui-accent)' : 'text-muted-foreground')}>
                  {copy(`${value}Description`)}
                </span>
              </span>
            </DropdownMenuRadioItem>
          )
        })}
      </DropdownMenuRadioGroup>
    </>
  )
}

export function useApprovalModeStatusbarItem(profile: string, requestGateway: ApprovalModeRequester): StatusbarItem {
  const { t } = useI18n()
  const copy = useApprovalModeCopy()
  const modes = useStore($approvalModes)
  const mode = modes[profile.trim() || 'default'] ?? 'smart'
  const Icon = MODE_ICONS[mode]
  useEffect(() => {
    void syncApprovalModeForProfile(requestGateway, profile).catch(() => undefined)
  }, [profile, requestGateway])

  return {
    className: mode === 'off' ? 'bg-(--ui-accent)/10 text-(--ui-accent) hover:text-(--ui-accent)' : undefined,
    icon: <Icon className="size-4" />,
    id: 'approval-mode',
    label: copy(mode),
    menuAlign: 'start',
    menuClassName: 'w-[30rem] max-w-[calc(100vw-2rem)] rounded-2xl p-1.5',
    menuContent: (
      <ApprovalModeOptions
        mode={mode}
        onSelect={value => {
          if (value !== mode) {
            void setApprovalModeForProfile(requestGateway, profile, value).catch(error =>
              notifyError(error, copy('failed'))
            )
          }
        }}
      />
    ),
    title: t.shell.approvalMode.ariaLabel(copy(mode)),
    variant: 'menu'
  }
}
