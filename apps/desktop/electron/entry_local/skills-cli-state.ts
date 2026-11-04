import { createHash } from 'node:crypto'
import { createConnection, createServer, type Server } from 'node:net'

let server: Server | undefined
let availableAccount: string | null = null
let stopping = false

/** 将应用数据根映射到本机管道，隔离测试实例和正式实例。 */
function pipePath(userData: string): string {
  return `\\\\.\\pipe\\uniworker-skills-${createHash('sha256').update(userData.toLowerCase()).digest('hex')}`
}

/** 账号准备完成后发布可用状态；管道只返回摘要，不传登录凭据。 */
export async function openSkillsCliState(userData: string, account: string): Promise<void> {
  if (process.platform !== 'win32') {
    return
  }

  availableAccount = stopping ? null : account
  server = createServer(socket => {
    socket.on('error', () => {})
    socket.end(JSON.stringify({ account: availableAccount }))
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(pipePath(userData), resolve)
  })
  server.unref()
}

/** 开始退出后立即拒绝新的自动定位，已开始的 CLI 仍使用原账号。 */
export function blockSkillsCliState(): void {
  stopping = true
  availableAccount = null
}

/** 查询运行中桌面；无管道时由调用方核对保存登录及退出记录。 */
export function readSkillsCliState(userData: string): Promise<string | null | undefined> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipePath(userData))
    let data = ''
    socket.setTimeout(2000, () => socket.destroy(new Error('桌面账号状态查询超时。')))
    socket.on('data', chunk => {
      data += chunk.toString()

      if (data.length > 256) {
        socket.destroy(new Error('桌面账号状态无效。'))
      }
    })
    socket.on('end', () => {
      try {
        const value = JSON.parse(data).account

        if (value !== null && !/^account-[a-f0-9]{64}$/.test(value)) {
          throw new Error()
        }

        resolve(value)
      } catch {
        reject(new Error('桌面账号状态无效。'))
      }
    })
    socket.on('error', error => {
      if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        resolve(undefined)
      } else {
        reject(error)
      }
    })
  })
}
