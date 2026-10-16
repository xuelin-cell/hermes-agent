import { afterEach, expect, it } from 'vitest'

import { getRuntimeI18nLocale, setRuntimeI18nLocale } from '@/i18n/runtime'
import { $notifications, clearNotifications, notifyError } from '@/store/notifications'

import { explainWindowsPathTooLong, isWindowsPathTooLong, windowsPathTooLongMessage } from './windows-path-too-long'

const initialLocale = getRuntimeI18nLocale()

afterEach(() => {
  setRuntimeI18nLocale(initialLocale)
  clearNotifications()
})

/** 生成实际长度为 length 的 Windows 路径，再按 separator 写出分隔符，用于贴近上限的边界检查。 */
function windowsPath(length: number, separator = '\\'): string {
  const head = ['C:', 'Users', 'stan', 'AppData', 'Local', 'hmt', '0123456789ab', 'home', ''].join('\\')

  return (head + 'a'.repeat(length - head.length)).split('\\').join(separator)
}

it('识别系统明确报告的名称过长', () => {
  for (const message of [
    "[WinError 206] 文件名或扩展名太长。: 'C:\\\\x'",
    '[WinError 206] The filename or extension is too long',
    'error: unable to create file docs/a.md: Filename too long'
  ]) {
    expect(isWindowsPathTooLong(message)).toBe(true)
  }
})

it('报错中的路径达到 260 字符才视为过长，并兼容 Python 与 JSON 的反斜杠转义', () => {
  expect(isWindowsPathTooLong(`[Errno 2] No such file or directory: '${windowsPath(259)}'`)).toBe(false)
  expect(isWindowsPathTooLong(`[Errno 2] No such file or directory: '${windowsPath(260)}'`)).toBe(true)
  // 每个反斜杠被转义成两个后字符串变长，但实际路径仍只有 259 字符。
  expect(isWindowsPathTooLong(`{"detail": "missing '${windowsPath(259, '\\\\')}'"}`)).toBe(false)
  expect(isWindowsPathTooLong(`{"detail": "missing '${windowsPath(260, '\\\\\\\\')}'"}`)).toBe(true)
  expect(isWindowsPathTooLong(`open ${windowsPath(300, '/')}`)).toBe(true)
  expect(isWindowsPathTooLong('ENAMETOOLONG: name too long, open /tmp/x')).toBe(false)
  expect(isWindowsPathTooLong('Install failed')).toBe(false)
})

it('说明按界面语言显示，并保留原始报错供排查', () => {
  setRuntimeI18nLocale('zh')
  expect(windowsPathTooLongMessage()).toContain('260 字符')
  setRuntimeI18nLocale('en')
  expect(windowsPathTooLongMessage()).toContain('260-character')

  const raw = '[WinError 206] The filename or extension is too long'
  expect(explainWindowsPathTooLong(raw)).toBe(`${windowsPathTooLongMessage()}\n${raw}`)
  expect(explainWindowsPathTooLong('Install failed')).toBe('Install failed')
})

it('错误提示用说明代替被截断的长报错，原文放在详情里', () => {
  setRuntimeI18nLocale('zh')
  const raw = `[Errno 2] No such file or directory: '${windowsPath(285)}'`
  notifyError(new Error(raw), '安装失败')
  const [toast] = $notifications.get()
  expect(toast?.title).toBe('安装失败')
  expect(toast?.message).toBe(windowsPathTooLongMessage())
  expect(toast?.detail).toBe(raw)
})
