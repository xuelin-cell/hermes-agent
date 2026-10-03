import path from 'node:path'

import { profileBackendParentEnv } from '../backend-env'
import { createSourcePythonBackend, type SourceBackend } from '../source-backend'

import type { PreparedLocalContext } from './runtime-context'

/** 清理旧 Home 的 dotenv 与启动提示；保留普通系统环境和本机工具配置。 */
export function accountDesktopEnvironment(
  context: PreparedLocalContext,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = profileBackendParentEnv({
    hermesHome: context.home,
    profile: 'default',
    currentEnv: inherited
  })

  for (const name of Object.keys(env)) {
    if (
      /^(?:DESKTOP_MT_MAAS_API_KEY|HERMES_PROFILE|HERMES_DASHBOARD_SESSION_TOKEN|HERMES_DESKTOP_(?:REMOTE_.+|CWD))$/i.test(
        name
      )
    ) {
      delete env[name]
    }
  }

  return {
    ...env,
    HERMES_HOME: context.home,
    HERMES_GATEWAY_LOCK_DIR: path.join(context.home, 'gateway-locks'),
    TERMINAL_CWD: context.workspace,
    HERMES_DESKTOP_HERMES_ROOT: context.installationRoot,
    HERMES_DESKTOP_PYTHON: context.python
  }
}

/** 只采用已验证的共享源码与解释器；缺失时不寻找官方安装或进入 bootstrap。 */
export function accountSourceBackend(
  context: PreparedLocalContext,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): SourceBackend {
  const isolatedArgs = args.includes('serve') ? [...args, '--isolated'] : args
  const backend = createSourcePythonBackend(context.installationRoot, context.python, isolatedArgs, { env })

  if (!backend) {
    throw new Error('账号开发运行时不可用，请检查源码与 Python。')
  }

  return backend
}
