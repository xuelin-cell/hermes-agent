/**
 * 启动期窗口规格：登录窗与主窗必须像素级同形，否则交接时会闪。
 *
 * 桌面启动有两个原生窗口：登录壳层先开一个窗等待账号恢复，账号就绪后聊天运行时
 * 再开主窗。两者之间是一次「销毁 A、显示 B」的替换——几何、边框、底色只要有一处
 * 不同，用户就会看到一次跳变。本模块把这段等待期用的窗口规格收敛成单一来源，
 * 让登录窗与主窗共用同一份决策。
 *
 * 窗口尺寸的读取/净化逻辑在 `window-state.ts`（纯函数），本模块只做组合。
 */

import fs from 'node:fs'
import path from 'node:path'

import type { BrowserWindowConstructorOptions, Display } from 'electron'

import { computeWindowOptions, MIN_HEIGHT, MIN_WIDTH, type SanitizedWindowState, sanitizeWindowState } from './window-state'

export interface BootWindowAppearance {
  /** `window-state.json` 净化后的几何状态；null 表示从未保存过。 */
  savedState: SanitizedWindowState | null
  /** Electron 的屏幕信息（`screen.getAllDisplays()`）。 */
  displays: Display[]
  /** 主窗使用的标题栏覆盖选项；登录窗复用同一份，否则两边按钮位置不同。 */
  titleBarOverlay: BrowserWindowConstructorOptions['titleBarOverlay']
  /** 平台判定结果，用于 macOS 交通灯位置等分支。 */
  platform: NodeJS.Platform
  /** 标题栏高度；macOS 交通灯的 y 偏移以它为基准。 */
  titlebarHeight: number
  /** 与主窗一致的窗口底色；渲染进程首帧之前由它打底。 */
  backgroundColor: string
  /** 图标路径；缺省时 Electron 用可执行文件图标。 */
  icon?: string
}

/**
 * 启动期窗口的公共外观：无边框 + 与主窗一致的覆盖层与底色。
 *
 * `show: false` 是硬要求：窗口必须由调用方在内容就绪后显式 show，否则会先闪一个
 * 未上色的空壳。
 */
export function bootWindowAppearanceOptions({
  savedState,
  displays,
  titleBarOverlay,
  platform,
  titlebarHeight,
  backgroundColor,
  icon
}: BootWindowAppearance): BrowserWindowConstructorOptions {
  return {
    ...computeWindowOptions(savedState, displays),
    // 与主窗一致的最小尺寸：交接后用户能拖出的范围也必须一样。
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // 与主窗一致的无边框标题栏：登录窗带原生边框会在交接瞬间多出一条标题栏。
    titleBarStyle: 'hidden',
    titleBarOverlay,
    // macOS 的交通灯位置与主窗一致，否则两窗的红绿灯不在同一处。
    trafficLightPosition:
      platform === 'darwin'
        ? { x: 24, y: titlebarHeight / 2 - 14 / 2 }
        : undefined,
    // 主窗在渲染进程首帧之前用这个底色打底；登录窗用同一份才接得上。
    backgroundColor,
    icon
  }
}

/** 上次是最大化启动时，窗口必须在首帧绘制前就最大化；晚一步会播可见的 zoom 动画。 */
export function bootWindowStartsMaximized(savedState: SanitizedWindowState | null): boolean {
  return savedState?.isMaximized === true
}

/** 渲染进程首帧之前的窗口打底色；主窗与登录窗必须是同一个值，否则交接时底色会跳。 */
export function bootWindowBackgroundColor(dark: boolean): string {
  return dark ? '#111111' : '#f7f7f7'
}

/** 读取并净化 `window-state.json`；缺失或损坏都当作「没有历史几何」。 */
export function readBootWindowState(file: string): SanitizedWindowState | null {
  try {
    return sanitizeWindowState(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/**
 * 登录壳层读到的窗口几何：与主窗读的是同一个 `window-state.json`。
 *
 * 登录壳层跑在聊天运行时之前，但它和主窗共用同一个 userData 目录，所以历史几何
 * 在这里就可用——这让登录窗可以一开始就落在主窗最终要出现的位置上。
 */
export function readBootWindowStateFrom(userDataDir: string): SanitizedWindowState | null {
  return readBootWindowState(path.join(userDataDir, 'window-state.json'))
}
