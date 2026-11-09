import fs from 'node:fs'
import path from 'node:path'

import { enableDesktopPlugins } from './desktop-plugins-config'
import { installArtifactSharePlugin } from './install-artifact-share'
import type { InterruptedTurns } from './interrupted-turns'

// 与 Hermes 的 Profile 身份文件一致；缓存目录和已删除档案不应被准备操作复活。
const IDENTITY_FILES = ['config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db']

interface PreparationOptions {
  home: string
  appRoot: string
  interrupted: Pick<InterruptedTurns, 'claim'>
  prepareDrive: (profile: string) => Promise<boolean>
  busy: (profile: string) => boolean
  log: (message: string) => void
}

/** 只枚举账号内的真实档案；链接、无身份目录和删除标记均不进入文件准备。 */
export function localProfileNames(home: string, log: PreparationOptions['log']): string[] {
  const root = path.join(home, 'profiles')
  const info = fs.lstatSync(root, { throwIfNoEntry: false })

  if (!info) {
    return []
  }

  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Invalid profiles directory')
  }

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(entry => {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.name) ||
        entry.name === 'default'
      ) {
        return false
      }

      try {
        if (fs.existsSync(path.join(root, '.deleted', entry.name))) {
          return false
        }

        return IDENTITY_FILES.some(name => {
          const marker = fs.lstatSync(path.join(root, entry.name, name), { throwIfNoEntry: false })

          return marker?.isFile() && !marker.isSymbolicLink()
        })
      } catch {
        log(`[profiles] could not inspect profile=${entry.name}`)

        return false
      }
    })
    .map(entry => entry.name)
    .sort()
}

/** 主后端启动前补齐未运行助手的配置；恢复时不改写仍在启动、运行或停止中的专家。 */
export async function prepareAllProfiles(options: PreparationOptions): Promise<Set<string>> {
  let names: string[] = []
  const prepared = new Set<string>()

  try {
    names = localProfileNames(options.home, options.log)
  } catch {
    options.log('[profiles] could not enumerate profiles for preparation')
  }

  for (const profile of ['default', ...names]) {
    if (options.busy(profile)) {
      continue
    }

    const home = profile === 'default' ? options.home : path.join(options.home, 'profiles', profile)

    try {
      enableDesktopPlugins(home, ['desktop-deliverables'])
      options.interrupted.claim(home)
      installArtifactSharePlugin(home, options.appRoot)

      if (!(await options.prepareDrive(profile))) {
        options.log(`[profiles] drive preparation unavailable profile=${profile}`)
      } else {
        prepared.add(profile)
      }
    } catch {
      options.log(`[profiles] preparation failed profile=${profile}`)
    }
  }

  return prepared
}
