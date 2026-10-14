import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { accountSourceBackend } from './desktop-environment'
import type { PreparedLocalContext } from './runtime-context'

/**
 * 开发模式账号环境预装的组件：内置 UniAI-Toolkit 要 mcp，微信扫码要 messaging（含 aiohttp）。
 * 安装版打包时已装好全部组件，不走这里。上游这两项不会在用到时自动补装。
 */
export const DEV_EXTRAS = ['mcp', 'messaging'] as const

/** 补装走账号已有的下载缓存，通常一分钟内完成；超时只放弃这次预装，桌面照常启动。 */
const SYNC_TIMEOUT_MS = 3 * 60_000

/** 与上游微信文档相同的安装写法；只追加组件，已记录的组件保留。 */
const SYNC_SCRIPT = 'import sys, pm; pm.sync_venv(sys.argv[1:], explicit=True)'

/**
 * PM 已为该账号记录的组件；null 表示账号还没有自己的环境（直接用源码目录的 .venv）。
 * 目录规则同 pm/environments.py 的 install_key：源码目录真实路径的 sha256 前 16 位。
 */
export function recordedExtras(home: string, installationRoot: string): null | string[] {
  let root = path.resolve(installationRoot)

  try {
    root = fs.realpathSync.native(root)
  } catch {
    // 目录不存在时按原路径计算，读不到记录就当作未安装。
  }

  const key = createHash('sha256').update(root).digest('hex').slice(0, 16)

  try {
    const facts = JSON.parse(fs.readFileSync(path.join(home, 'installs', key, 'facts.json'), 'utf8'))
    const extras = facts?.packages?.venv?.extras

    return Array.isArray(extras) ? extras.filter((extra): extra is string => typeof extra === 'string') : null
  } catch {
    return null
  }
}

/** 用后端相同的解释器和环境运行一次安装，返回是否成功。 */
function runSync(context: PreparedLocalContext, env: NodeJS.ProcessEnv, extras: string[]): Promise<boolean> {
  const backend = accountSourceBackend(context, [], env)

  return new Promise(resolve => {
    const child = spawn(backend.command, ['-c', SYNC_SCRIPT, ...extras], {
      cwd: context.installationRoot, env: { ...env, ...backend.env }, windowsHide: true, stdio: 'ignore'
    })

    const timer = setTimeout(() => child.kill(), SYNC_TIMEOUT_MS)

    child.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.once('close', code => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/**
 * 开发模式下给已有自己环境的账号补装缺少的组件；都已记录时不启动 Python。失败只记一行日志，桌面照常启动。
 *
 * 新账号直接用源码目录的 .venv（已含 aiohttp），这里跳过：从零建环境要重新下载全部依赖，
 * 慢网下超过十分钟，不能卡住登录。账号第一次装组件、有了自己的环境后，下次启动再补齐。
 * 设置 HERMES_DESKTOP_MT_SKIP_DEV_EXTRAS=1 可完全跳过（原生测试的临时账号、离线开发）。
 */
export async function ensureDevExtras(
  context: PreparedLocalContext,
  env: NodeJS.ProcessEnv,
  run: typeof runSync = runSync
): Promise<void> {
  if (context.sitePackages || process.env.HERMES_DESKTOP_MT_SKIP_DEV_EXTRAS === '1') {
    return
  }

  const recorded = recordedExtras(context.home, context.installationRoot)
  const missing = DEV_EXTRAS.filter(extra => !recorded?.includes(extra))

  if (recorded === null || missing.length === 0) {
    return
  }

  // 日志不带路径或原始错误，避免泄露账号目录。
  if (!(await run(context, env, missing))) {
    console.warn(`[desktop-mt] 开发模式预装组件失败：${missing.join(', ')}`)
  }
}
