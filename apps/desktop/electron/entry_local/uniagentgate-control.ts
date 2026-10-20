import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

import type { UniAgentGateUpdate } from '../login/uniagentgate'

import type { PreparedLocalContext } from './runtime-context'
import { startAccountMessagingGateway } from './start-messaging-gateway'
import { updateUniAgentGateConfig } from './uniagentgate-config'
import type { UniAgentGateReconnectResult } from './uniagentgate-contract'

/** 仅应用可信会话的返回值；启动前仍由账号准备落盘，不启动第二个网关。 */
export function createUniAgentGateBindingUpdate(readContext: () => PreparedLocalContext | null) {
  return async (update: UniAgentGateUpdate): Promise<void> => {
    const context = readContext()

    if (!context || !['available', 'clear'].includes(update.status)) {
      return
    }

    updateUniAgentGateConfig(context.home, update)

    try {
      const result = await requestUniAgentGateReconnect(context.home, 'apply_binding')

      if (!['connected', 'connecting', 'unbound'].includes(result.status)) {
        console.warn('[desktop-mt] 5G 绑定已保存，运行中的连接未完成更新，请查看网关状态。')
      }
    } catch {
      console.warn('[desktop-mt] 5G 绑定已保存，网关控制通道不可用；请完整退出应用后重启。')
    }
  }
}

/** 凭证只在主进程与所属账号网关间使用；页面不能指定地址、路径或身份。 */
export async function requestUniAgentGateReconnect(
  home: string,
  operation: 'reconnect' | 'apply_binding' = 'reconnect'
): Promise<UniAgentGateReconnectResult> {
  const file = path.join(home, 'uniagentgate-control.json')
  const info = await fs.lstat(file)

  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) {
    throw new Error('Invalid control record')
  }

  const { port, token } = JSON.parse(await fs.readFile(file, 'utf8'))

  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('Invalid control endpoint')
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let body = ''
    let settled = false

    socket.setTimeout(55_000, () => socket.destroy(new Error('Reconnect timed out')))
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(JSON.stringify({ operation, token }) + '\n'))
    socket.on('data', chunk => {
      body += chunk

      if (body.length > 4096) {
        socket.destroy(new Error('Invalid control response'))
      } else if (body.includes('\n')) {
        try {
          const result = JSON.parse(body.slice(0, body.indexOf('\n')))
          const statuses = ['connected', 'connecting', 'busy', 'failed', 'unbound', 'stopped']

          if (!statuses.includes(result.status)) {
            throw new Error('Invalid control status')
          }

          settled = true
          resolve({ status: result.status })
          socket.end()
        } catch {
          socket.destroy(new Error('Invalid control response'))
        }
      }
    })
    socket.once('error', reject)
    socket.once('close', () => {
      if (!settled) {
        reject(new Error('Control connection closed'))
      }
    })
  })
}

/** 网关不存在时复用账号启动器；不会停止或重启其它正在运行的平台。 */
export function createUniAgentGateReconnect(readContext: () => PreparedLocalContext | null) {
  let pending: Promise<UniAgentGateReconnectResult> | null = null

  return (): Promise<UniAgentGateReconnectResult> => {
    if (pending) {
      return pending
    }

    const context = readContext()

    if (!context) {
      return Promise.resolve({ status: 'unavailable' })
    }

    pending = (async (): Promise<UniAgentGateReconnectResult> => {
      try {
        return await requestUniAgentGateReconnect(context.home)
      } catch (error) {
        // 已发送但未获结果时不能自动重复重连；只为缺记录/死端口启动网关。
        if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '') ||
            readContext() !== context) {
          return { status: 'failed' }
        }

        // 旧版账号插件没有控制入口；重复 gateway run 不会升级已运行的插件。
        try {
          await fs.access(path.join(context.home, 'plugins', 'uniagentgate', 'control.py'))
        } catch (error) {
          return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'restart_required' : 'failed' }
        }

        // 只有控制通道不可用才尝试启动；原生 gateway run 自身拒绝接管活跃网关。
        try {
          await startAccountMessagingGateway(context)

          for (let attempt = 0; attempt < 30 && readContext() === context; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 500))

            try {
              return await requestUniAgentGateReconnect(context.home)
            } catch (error) {
              if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                return { status: 'failed' }
              }
              // 等待当前账号网关发布控制凭证，不能借用旧账号或全局网关。
            }
          }
        } catch {
          return { status: 'unavailable' }
        }

        return { status: 'restart_required' }
      }
    })().finally(() => {
      pending = null
    })

    return pending
  }
}
