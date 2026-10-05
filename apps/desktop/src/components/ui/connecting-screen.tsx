import { DecodeText } from '@/components/ui/decode-text'
import { cn } from '@/lib/utils'

export type ConnectingPhase = 'live' | 'text-out' | 'overlay-out' | 'gone'

interface ConnectingScreenProps {
  active?: boolean
  phase?: ConnectingPhase
}

/** 登录交接与原版桌面共用启动画面，纯展示层不加载聊天状态或后端连接。 */
export function ConnectingScreen({ active = true, phase = 'live' }: ConnectingScreenProps) {
  const leaving = phase !== 'live'
  const overlayHidden = phase === 'overlay-out' || phase === 'gone'

  return (
    <div
      aria-label="CONNECTING"
      className={cn(
        'fixed inset-0 z-(--z-connecting) grid place-items-center bg-(--ui-chat-surface-background) transition-opacity duration-500 ease-out',
        overlayHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
      )}
      data-glass-opaque=""
      role="status"
    >
      <DecodeText
        active={active}
        className={cn(
          'pl-[0.4em] text-(--theme-primary) transition duration-300 ease-out',
          leaving ? 'translate-y-2 opacity-0 saturate-0' : 'translate-y-0 opacity-100 saturate-100'
        )}
        cursor
        loop
        prefix={4}
        text="CONNECTING"
      />
    </div>
  )
}
