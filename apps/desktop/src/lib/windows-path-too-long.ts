import { getRuntimeI18nLocale } from '@/i18n/runtime'

// desktop-mt：Windows 默认路径上限 260 字符（含结尾空字符，实际可用 259）。
const WINDOWS_MAX_PATH = 260

// 系统或 Git 明确说明“名称太长”的报错；不含 POSIX 的 ENAMETOOLONG（单个文件名超 255 字节，原因不同）。
const TOO_LONG_RE =
  /WinError 206\b|文件名或扩展名太长|檔案名稱或副檔名太長|filename or extension is too long|\bFilename too long\b/i

// 报错里的 Windows 绝对路径；Python 与 JSON 转义会把一个反斜杠写成两到四个。
const WINDOWS_PATH_RE = /[A-Za-z]:(?:\\+|\/)[^'"`\r\n<>|?*]+/g

/** 判断报错是否由 Windows 路径过长引起：系统明确报“太长”，或报错中的路径本身已达上限。 */
export function isWindowsPathTooLong(message: string): boolean {
  if (TOO_LONG_RE.test(message)) {
    return true
  }

  return (message.match(WINDOWS_PATH_RE) ?? []).some(
    candidate => candidate.replace(/\\+/g, '\\').trimEnd().length >= WINDOWS_MAX_PATH
  )
}

/** 按界面语言说明路径过长的原因和可行做法；不要求用户修改系统设置。 */
export function windowsPathTooLongMessage(): string {
  return getRuntimeI18nLocale().startsWith('zh')
    ? '文件路径超过了 Windows 的 260 字符上限，操作没有完成。通常是插件或技能包里的文件夹层级太深、文件名太长，请联系技术支持，或改用目录层级更浅的版本。'
    : "A file path went over the Windows 260-character limit, so this didn't finish. The plugin or skill package probably nests folders too deeply or uses very long names. Contact support, or use a version with a shallower layout."
}

/** 路径过长的报错换成说明并保留原文供排查，其他报错原样返回。 */
export function explainWindowsPathTooLong(message: string): string {
  return isWindowsPathTooLong(message) ? `${windowsPathTooLongMessage()}\n${message}` : message
}
