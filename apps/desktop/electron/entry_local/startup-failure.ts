import { app, type BrowserWindow, dialog } from 'electron'

type StartupStage = 'directory' | 'config' | 'credentials' | 'runtime' | 'backend'

const descriptions: Record<StartupStage, string> = {
  directory: '无法准备账号的本地存储空间。',
  config: '无法加载或保存账号配置。',
  credentials: '无法安全保存账号凭据。',
  runtime: '本地运行组件无法使用。',
  backend: '本地服务未能启动或连接。'
}

/** 只识别存储错误；后端输出只参与内部分类，不回显原始异常或凭据。 */
function failureAdvice(error: unknown): string {
  let current = error

  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const item = current as { code?: string; message?: string; cause?: unknown }
    const message = typeof item.message === 'string' ? item.message : ''

    if (
      item.code === 'ENOSPC' ||
      item.code === 'EDQUOT' ||
      /no space left on device|database or disk is full|\bENOSPC\b|disk full/i.test(message)
    ) {
      return '存储空间不足，请先释放空间。'
    }

    if (
      ['EACCES', 'EPERM', 'EROFS'].includes(item.code ?? '') ||
      /permission denied|\bEACCES\b|\bEPERM\b|read-only file system|\bEROFS\b|operation not permitted/i.test(message)
    ) {
      return '本地存储无法访问或写入，请确认应用具有访问权限。'
    }

    current = item.cause
  }

  return ''
}

/** 固定安全提示，保留内部原因供分类，不把半完成的环境当成可用环境。 */
export class LocalStartupError extends Error {
  /** 阶段由主进程指定；未知异常只用于分类，不拼接原始文本。 */
  constructor(stage: StartupStage, cause?: unknown) {
    super(
      `${descriptions[stage]}${failureAdvice(cause)}请完整退出应用后重新打开，不是关闭到托盘。账号数据会保留；若仍然失败，请寻求支持。`,
      { cause }
    )
    this.name = 'LocalStartupError'
  }
}

let reported = false

/** 一个启动失败只提示一次；用户关闭提示后复用正常退出，不自动重启或清空数据。 */
export function showLocalStartupFailure(error: LocalStartupError, parent?: BrowserWindow | null): void {
  if (reported) {
    return
  }

  reported = true

  const options: Electron.MessageBoxOptions = {
    type: 'error',
    title: 'Hermes Desktop MT',
    message: error.message,
    buttons: ['退出应用'],
    defaultId: 0,
    cancelId: 0
  }

  const result =
    parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)

  void result.then(
    () => app.quit(),
    () => app.quit()
  )
}
