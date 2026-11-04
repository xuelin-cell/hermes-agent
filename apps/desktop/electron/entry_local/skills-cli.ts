import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import { resolveDesktopUserData } from '../data-paths'
import { CredentialStore } from '../login/credential-store'
import { createSourcePythonBackend } from '../source-backend'

import { accountDataRoot, assertAccountDirectoryOwner, resolveAccountPaths } from './account-paths'
import { resolveAccountInstallation } from './runtime-installation'
import { readSkillsCliState } from './skills-cli-state'

/** 跳过官方 Profile 全局参数，只对 skills 子命令自动选择桌面账号。 */
export function isSkillsCommand(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === '--profile' || arg === '-p') {
      index++

      continue
    }

    if (arg.startsWith('--profile=')) {
      continue
    }

    return arg === 'skills'
  }

  return false
}

/** 使用同一份系统加密记录定位账号，读取失败时不创建或认领目录。 */
export async function savedSkillsHome(userData: string): Promise<string> {
  const identity = new CredentialStore(userData).load()

  if (!identity || identity.expiresAt <= Date.now()) {
    throw new Error('请先在 UniWork 中登录有效账号，再安装或查询技能。')
  }

  const roots = { data: accountDataRoot(app.getPath('home')), userData }
  const account = resolveAccountPaths(roots, identity.namespace, identity.uid)
  assertAccountDirectoryOwner(account)
  const active = await readSkillsCliState(userData)

  if (
    active !== account.id &&
    (active !== undefined || fs.existsSync(path.join(userData, 'maas-logout-pending.json')))
  ) {
    throw new Error('账号正在退出或等待恢复，请先在 UniWork 中完成处理。')
  }

  // 查询期间可能发生注销或重新登录，再次读取并核对同一身份与期限。
  const current = new CredentialStore(userData).load()

  if (!current || current.uid !== identity.uid || current.token !== identity.token || current.expiresAt <= Date.now()) {
    throw new Error('登录状态已变化，请重新运行命令。')
  }

  for (const directory of [roots.data, path.dirname(account.home), account.home]) {
    const stat = fs.lstatSync(directory)

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('账号技能目录无效。')
    }
  }

  return account.home
}

/** 仅向终端返回启动参数；Python 由 PowerShell 启动以保留真正的控制台输入输出。 */
export function runDesktopSkillsCli(request: string[]): void {
  const file = request[0]
  app.setName('Hermes Desktop MT')
  const userData = resolveDesktopUserData(path.join(app.getPath('appData'), 'uniworker'))
  app.setPath('userData', userData)
  void app
    .whenReady()
    .then(async () => {
      const args: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))

      if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) {
        throw new Error('CLI 参数格式无效。')
      }

      const env = { ...process.env }

      if (isSkillsCommand(args) && !env.HERMES_HOME) {
        env.HERMES_HOME = await savedSkillsHome(userData)
      }

      const root = process.env.HERMES_DESKTOP_HERMES_ROOT || path.resolve(app.getAppPath(), '../..')
      const runtime = resolveAccountInstallation(root, process.env.HERMES_DESKTOP_PYTHON)
      const backend = createSourcePythonBackend(runtime.installationRoot, runtime.python, args, { env })!

      if (runtime.sitePackages) {
        backend.env.PYTHONPATH = [runtime.installationRoot, runtime.sitePackages].join(path.delimiter)
      }

      // 只返回启动所需路径与 Python 环境覆盖值，不序列化完整环境或登录凭据。
      fs.writeFileSync(
        file + '.result',
        JSON.stringify({
          command: backend.command,
          args: backend.args,
          env: { ...backend.env, ...(env.HERMES_HOME ? { HERMES_HOME: env.HERMES_HOME } : {}) }
        }),
        { flag: 'wx', mode: 0o600 }
      )
      app.exit(0)
    })
    .catch(error => {
      const message = error instanceof Error ? error.message : '无法读取桌面账号。'

      try {
        fs.writeFileSync(file + '.result', JSON.stringify({ error: message }), { flag: 'wx', mode: 0o600 })
      } finally {
        app.exit(1)
      }
    })
}
