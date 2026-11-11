/**
 * 应用主题（深/浅/跟随系统）的持久化。
 *
 * 主进程必须在创建任何窗口之前把它钉到 `nativeTheme.themeSource`：窗口首帧的
 * 底色、原生标题栏、`prefers-color-scheme` 都跟着它走。登录壳层早于聊天运行时
 * 启动，但读的是同一个 `native-theme.json`，所以两边共用这一份读写逻辑——各写
 * 一份会在冷启动时出现「启动画面一种深浅、主窗另一种深浅」的底色接缝。
 */

import fs from 'node:fs'
import path from 'node:path'

export const NATIVE_THEME_FILE = 'native-theme.json'

export type ThemeSourceMode = 'dark' | 'light' | 'system'

const THEME_SOURCES: readonly ThemeSourceMode[] = ['dark', 'light', 'system']

export function isThemeSourceMode(value: unknown): value is ThemeSourceMode {
  return THEME_SOURCES.includes(value as ThemeSourceMode)
}

/** 读取已保存的应用主题；文件缺失或损坏时按出厂浅色。 */
export function readThemeSource(userDataDir: string): ThemeSourceMode {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(userDataDir, NATIVE_THEME_FILE), 'utf8'))

    if (parsed && isThemeSourceMode(parsed.themeSource)) {
      return parsed.themeSource
    }
  } catch {
    // 缺失 / 损坏 → 出厂浅色
  }

  return 'light'
}

export function writeThemeSource(userDataDir: string, mode: ThemeSourceMode): void {
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(path.join(userDataDir, NATIVE_THEME_FILE), JSON.stringify({ themeSource: mode }, null, 2), 'utf8')
}
