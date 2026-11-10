import { useState } from 'react'

import { Button } from '@/components/ui/button'

import { MessagingView } from '../messaging'

import { ContextSettings } from './context-settings'
import { useSettingsRedesignCopy } from './redesign-copy'

export function PhoneSettings() {
  const copy = useSettingsRedesignCopy()
  const [context, setContext] = useState(false)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-2 px-6 pb-3">
        <Button
          aria-pressed={!context}
          onClick={() => setContext(false)}
          size="sm"
          variant={context ? 'ghost' : 'outline'}
        >
          {copy('phone')}
        </Button>
        <Button
          aria-pressed={context}
          onClick={() => setContext(true)}
          size="sm"
          variant={context ? 'outline' : 'ghost'}
        >
          {copy('context')}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{context ? <ContextSettings /> : <MessagingView />}</div>
    </div>
  )
}
