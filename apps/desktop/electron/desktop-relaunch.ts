import { app } from 'electron'

let pending: Promise<void> | null = null

/** 托管工作停止后重启桌面；开发模式通知监督进程，普通运行使用 Electron 原生重启。 */
export function relaunchDesktop(): Promise<void> {
  if (pending) {
    return pending
  }

  pending = (async () => {
    if (process.env.HERMES_DESKTOP_DEV_SUPERVISOR === '1') {
      if (!process.connected || !process.send) {
        throw new Error('开发启动器已断开，无法自动重启桌面')
      }

      await new Promise<void>((resolve, reject) => {
        process.send({ type: 'hermes-desktop:relaunch' }, error => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
    } else {
      app.relaunch()
    }

    app.quit()
  })().catch(error => {
    pending = null
    throw error
  })

  return pending
}
