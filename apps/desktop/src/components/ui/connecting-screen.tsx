import './connecting-screen.css'

import { BrandMark } from '@/components/brand-mark'
import { registerPluginLocales, usePluginI18n } from '@/i18n/plugin-i18n'
import { cn } from '@/lib/utils'

const SCOPE = 'desktop-mt.startup'
registerPluginLocales(SCOPE, {
  en: {
    brand: 'UniWork',
    partner: 'UniWork, your intelligent work companion',
    ready: 'Reliable and ready for productive work',
    workspace: 'Preparing your intelligent workspace',
    starting: 'Starting services…'
  },
  zh: {
    brand: '元景数字员工',
    partner: '元景数字员工，你的智能工作伙伴',
    ready: '安全可靠，随时开始高效工作',
    workspace: '正在准备你的智能工作空间',
    starting: '正在启动服务…'
  },
  'zh-hant': {
    brand: '元景數位員工',
    partner: '元景數位員工，你的智慧工作夥伴',
    ready: '安全可靠，隨時開始高效工作',
    workspace: '正在準備你的智慧工作空間',
    starting: '正在啟動服務…'
  }
})

export type ConnectingPhase = 'live' | 'text-out' | 'overlay-out' | 'gone'

interface ConnectingScreenProps {
  active?: boolean
  phase?: ConnectingPhase
  label?: string
}

/** 登录交接与原版桌面共用启动画面，纯展示层不加载聊天状态或后端连接。 */
export function ConnectingScreen({ active = true, phase = 'live', label }: ConnectingScreenProps) {
  const copy = usePluginI18n(SCOPE)
  const leaving = phase !== 'live'
  const overlayHidden = phase === 'overlay-out' || phase === 'gone'

  return (
    <div
      aria-label={label ?? copy('starting')}
      className={cn(
        'fixed inset-0 z-(--z-connecting) grid place-items-center bg-(--ui-chat-surface-background) transition-opacity duration-500 ease-out',
        overlayHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
      )}
      data-glass-opaque=""
      role="status"
    >
      <div className="startup-brand">
        <BrandMark className="size-8" />
        <span>{copy('brand')}</span>
      </div>
      <section
        className={cn('startup-content', leaving && 'startup-content-leaving')}
        data-paused={!active || leaving ? 'true' : undefined}
      >
        <div aria-hidden="true" className="startup-headlines">
          {(['partner', 'ready', 'workspace', 'partner'] as const).map((key, index) => (
            <h1 className="startup-headline" key={index} style={{ animationDelay: `${index * 2.4}s` }}>
              {copy(key)}
            </h1>
          ))}
        </div>
        <div aria-label={copy('starting')} className="startup-progress" role="progressbar" />
        <p className="text-center text-[13px] font-medium text-muted-foreground">{label ?? copy('starting')}</p>
      </section>
    </div>
  )
}
