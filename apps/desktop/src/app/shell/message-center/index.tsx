import { useMaasAccount } from '@/app/shell/maas-account-status'

import { useNtfySubscription } from './use-ntfy-subscription'

/**
 * 订阅跟随当前账号：登录后自动建立，退出登录断开并清走上一个账号的公告。
 * 本身不渲染任何东西，挂在应用外壳里。
 *
 * 列表本体已迁到工作区整页（app/notifications），这里只剩连接与数据同步；
 * 入口组件见 ./entry（侧栏账号行）。
 */
export function MessageCenterSync() {
  const account = useMaasAccount()
  useNtfySubscription(account?.maskedPhone ?? null)

  return null
}
