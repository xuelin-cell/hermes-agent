import { app } from 'electron'

import { accountDesktopEnvironment } from './desktop-environment'
import { ensureDevExtras } from './dev-extras'
import { recordAccountRun } from './logout'
import type { PreparedLocalContext } from './runtime-context'
import { startAccountMessagingGateway } from './start-messaging-gateway'
import { installUniAgentGatePlugin } from './uniagentgate-config'

/** 绑定可信账号后才加载原版桌面；不接受页面传入的账号、路径或连接。 */
export async function startAccountDesktop(
  context: PreparedLocalContext,
  mayStartMessaging: () => boolean
): Promise<void> {
  recordAccountRun(app.getPath('userData'), context.id)
  const env = accountDesktopEnvironment(context)
  // 后端启动前装好开发模式缺的组件，免得用到时才报缺依赖。
  await ensureDevExtras(context, env)
  const messagingEnabled = installUniAgentGatePlugin(context.home, app.getAppPath())

  for (const name of Object.keys(process.env)) {
    if (!(name in env)) {
      delete process.env[name]
    }
  }

  Object.assign(process.env, env)
  const { openAccountDesktop } = await import('../main')
  await openAccountDesktop()

  if (messagingEnabled && mayStartMessaging()) {
    try {
      await startAccountMessagingGateway(context)
    } catch {
      // 网关失败不能撤销已经成功的登录；详情在账号网关日志和状态中。
      console.warn('[desktop-mt] 5G 消息网关进程启动失败，请查看消息网关状态。')
    }
  }
}
