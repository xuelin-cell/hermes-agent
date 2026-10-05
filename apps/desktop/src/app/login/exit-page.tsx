import { ConnectingScreen } from '@/components/ui/connecting-screen'
import { useI18n } from '@/i18n/context'

/** 复用官方启动画面显示退出状态，不挂载账号、登录或聊天逻辑。 */
export function AccountExitPage() {
  const { t } = useI18n()

  return <ConnectingScreen label={t.desktopLogin.logoutBusy} />
}
