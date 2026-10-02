import { spawn } from 'node:child_process'
import path from 'node:path'
import electronPath from 'electron'
import { isMain } from '../../../scripts/build/frontend-common.mjs'

/** 保持开发命令存活，仅在旧 Electron 正常退出且明确请求重启时再启动一次。 */
export async function superviseElectron({ args = ['.'], cwd = path.resolve(import.meta.dirname, '..'), env = process.env } = {}) {
  let child
  let stopping = false
  const childEnv = { ...env, HERMES_DESKTOP_DEV_SUPERVISOR: '1' }
  delete childEnv.ELECTRON_RUN_AS_NODE

  /** 终端取消时禁止重启，并停止本启动器持有的子进程。 */
  const stop = () => {
    stopping = true
    child?.kill()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    while (!stopping) {
      let relaunch = false
      const code = await new Promise((resolve, reject) => {
        child = spawn(electronPath, args, {
          // Electron 本身是用户界面，不能使用隐藏辅助进程窗口的启动标志。
          cwd, env: childEnv, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: false
        })
        child.on('message', message => {
          if (message?.type === 'hermes-desktop:relaunch') relaunch = true
        })
        child.once('error', reject)
        child.once('close', (exitCode, signal) => resolve(signal ? 1 : (exitCode ?? 1)))
      })
      if (stopping || code !== 0 || !relaunch) return code
      // 重启意图属于刚退出的进程；下一轮不继承，崩溃不会触发自动重试。
    }
    return 0
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = await superviseElectron()
  } catch (error) {
    console.error('[desktop-dev] Electron launch failed:', error.message)
    process.exitCode = 1
  }
}
