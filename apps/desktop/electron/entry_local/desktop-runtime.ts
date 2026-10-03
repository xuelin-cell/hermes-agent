import { accountDesktopEnvironment } from './desktop-environment'
import type { PreparedLocalContext } from './runtime-context'

/** 绑定可信账号后才加载原版桌面；不接受页面传入的账号、路径或连接。 */
export async function startAccountDesktop(context: PreparedLocalContext): Promise<void> {
  const env = accountDesktopEnvironment(context)

  for (const name of Object.keys(process.env)) {
    if (!(name in env)) {
      delete process.env[name]
    }
  }

  Object.assign(process.env, env)
  const { openAccountDesktop } = await import('../main')
  await openAccountDesktop()
}
