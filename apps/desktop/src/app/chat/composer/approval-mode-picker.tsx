import { useStore } from '@nanostores/react'
import { useCallback } from 'react'

import { useApprovalModeStatusbarItem } from '@/app/shell/approval-mode-menu'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { HermesGateway } from '@/hermes'
import { cn } from '@/lib/utils'
import { requestGatewayForAgent } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { knownOwnerForSession } from '@/store/session-states'

interface ApprovalModePickerProps {
  gateway?: HermesGateway | null
  sessionId?: string | null
}

export function ApprovalModePicker({ gateway, sessionId }: ApprovalModePickerProps) {
  const activeProfile = useStore($activeGatewayProfile)
  const owner = knownOwnerForSession(sessionId)
  const profile = typeof owner === 'string' ? owner : (owner?.profile ?? activeProfile)
  const connectionId = typeof owner === 'object' && owner ? owner.connectionId : null

  const request = useCallback(
    (method: string, params?: Record<string, unknown>) => {
      if (!gateway) {
        return Promise.reject(new Error('Gateway unavailable'))
      }

      return requestGatewayForAgent(connectionId, profile, method, params)
    },
    [connectionId, gateway, profile]
  )

  const item = useApprovalModeStatusbarItem(profile, request)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={item.title}
          className={cn(
            'h-(--composer-control-size) shrink-0 gap-1.5 rounded-full text-xs font-normal',
            item.className
          )}
          disabled={!gateway}
          size="sm"
          variant="ghost"
        >
          {item.icon}
          <span>{item.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={item.menuClassName} side="top" sideOffset={8}>
        {typeof item.menuContent === 'function' ? item.menuContent(() => undefined) : item.menuContent}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
