import { app, net } from 'electron'

import type { LoginIdentity } from '../login/session'

import { accountDesktopEnvironment } from './desktop-environment'
import { desktopPythonPluginsRoot, retireAccountUniAgentGatePlugin } from './desktop-python-plugins'
import { ensureDevExtras } from './dev-extras'
import { recordAccountRun } from './logout'
import type { PreparedLocalContext } from './runtime-context'
import { openSkillsCliState } from './skills-cli-state'
import { prepareUniSearchConfiguration, refreshUniSearch } from './unisearch'

/** 绑定可信账号后才加载原版桌面；不接受页面传入的账号、路径或连接。 */
export async function startAccountDesktop(
  context: PreparedLocalContext,
  identity: () => LoginIdentity | null
): Promise<void> {
  recordAccountRun(app.getPath('userData'), context.id)
  const env = accountDesktopEnvironment(context)
  env.HERMES_BUNDLED_PLUGINS = desktopPythonPluginsRoot(
    app.getAppPath(),
    app.isPackaged ? process.resourcesPath : undefined
  )
  retireAccountUniAgentGatePlugin(context.home, env.HERMES_BUNDLED_PLUGINS)
  // 后端启动前装好开发模式缺的组件，免得用到时才报缺依赖。
  await ensureDevExtras(context, env)
  await prepareUniSearchConfiguration(context, app.getAppPath(), app.isPackaged ? process.resourcesPath : undefined)
  // 联网刷新和可选抓取依赖在后台准备，桌面打开不等待它们。
  void refreshUniSearch(
    context,
    identity,
    net.fetch,
    app.getAppPath(),
    app.isPackaged ? process.resourcesPath : undefined
  )

  for (const name of Object.keys(process.env)) {
    if (!(name in env)) {
      delete process.env[name]
    }
  }

  Object.assign(process.env, env)
  // main 的账号恢复队列统一启动所有消息平台，避免两套启动器并发拉起网关。
  const { openAccountDesktop } = await import('../main')
  await openAccountDesktop()
  await openSkillsCliState(app.getPath('userData'), context.id)
}
