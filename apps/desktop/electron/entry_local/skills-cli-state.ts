import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createConnection, createServer, type Server } from 'node:net'

let server: Server | undefined
let availableAccount: string | null = null
let stopping = false

/** 将应用数据根映射到本机管道，隔离测试实例和正式实例。 */
export function skillsCliAddress(userData: string, platform = process.platform): string {
  const key = platform === 'win32' ? userData.toLowerCase() : userData
  const digest = createHash('sha256').update(key).digest('hex')

  return platform === 'win32'
    ? `\\\\.\\pipe\\uniwork-skills-${digest}`
    : `/tmp/uniwork-cli-${digest.slice(0, 32)}.sock`
}

/** 账号准备完成后发布可用状态；管道只返回摘要，不传登录凭据。 */
export async function openSkillsCliState(userData: string, account: string): Promise<void> {
  if (!['win32', 'darwin'].includes(process.platform)) {
    return
  }

  const address = skillsCliAddress(userData)

  if (process.platform === 'darwin') {
    const existing = fs.lstatSync(address, { throwIfNoEntry: false })

    if (existing) {
      if (!existing.isSocket() || existing.uid !== process.getuid!()) {
        throw new Error('账号状态 Socket 路径已被占用。')
      }

      // 只删除同用户、已无法连接的崩溃残留 Socket，拒绝覆盖仍在运行的实例。
      if ((await readSkillsCliState(userData)) !== undefined) {
        throw new Error('账号状态服务已在运行。')
      }

      fs.unlinkSync(address)
    }
  }

  availableAccount = stopping ? null : account
  server = createServer(socket => {
    socket.on('error', () => {})
    socket.end(JSON.stringify({ account: availableAccount }))
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(address, resolve)
  })

  if (process.platform === 'darwin') {
    fs.chmodSync(address, 0o600)
    process.once('exit', () => {
      server?.close()
    })
  }

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
    const socket = createConnection(skillsCliAddress(userData))
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
