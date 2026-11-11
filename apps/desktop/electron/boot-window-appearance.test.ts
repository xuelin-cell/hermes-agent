/**
 * 启动期窗口规格的契约测试。
 *
 * 关键不变式只有一条：登录壳层的窗口与随后出现的主窗必须算出同一份几何、同一套
 * 标题栏和同一个底色。任一处不同，「销毁登录窗、显示主窗」的交接就会变成一次
 * 可见跳变——也就是用户报告的「小窗闪到大窗」。
 */

import assert from 'node:assert/strict'

import type { Display } from 'electron'
import { test } from 'vitest'

import {
  bootWindowAppearanceOptions,
  bootWindowBackgroundColor,
  bootWindowStartsMaximized
} from './boot-window-appearance'
import { computeWindowOptions, MIN_HEIGHT, MIN_WIDTH, type SanitizedWindowState } from './window-state'

// 单屏 1920×1080，工作区扣掉任务栏。
const PRIMARY = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] as unknown as Display[]

const OVERLAY = { color: 'rgba(1, 0, 0, 0)', height: 34, symbolColor: '#242424' }

function bootOptions(savedState: SanitizedWindowState | null, platform: NodeJS.Platform = 'win32') {
  return bootWindowAppearanceOptions({
    savedState,
    displays: PRIMARY,
    titleBarOverlay: OVERLAY,
    platform,
    titlebarHeight: 34,
    backgroundColor: bootWindowBackgroundColor(false)
  })
}

test('启动窗与主窗算出同一份几何、标题栏和底色', () => {
  const savedState: SanitizedWindowState = { width: 1440, height: 900, isMaximized: false, x: 100, y: 60 }
  const options = bootOptions(savedState)

  assert.deepEqual(
    { width: options.width, height: options.height, x: options.x, y: options.y },
    computeWindowOptions(savedState, PRIMARY)
  )
  // 带原生边框会在交接瞬间多出一条标题栏。
  assert.equal(options.titleBarStyle, 'hidden')
  assert.deepEqual(options.titleBarOverlay, OVERLAY)
  assert.equal(options.backgroundColor, '#f7f7f7')
  assert.equal(options.minWidth, MIN_WIDTH)
  assert.equal(options.minHeight, MIN_HEIGHT)
  // 非 macOS 不设置交通灯位置；主窗同样只在 IS_MAC 时传。
  assert.equal(options.trafficLightPosition, undefined)
})

test('没有历史几何时两窗落到同一组默认尺寸', () => {
  const options = bootOptions(null)
  const expected = computeWindowOptions(null, PRIMARY)

  assert.equal(options.width, expected.width)
  assert.equal(options.height, expected.height)
  assert.equal(options.x, undefined)
  assert.equal(options.y, undefined)
})

test('macOS 按主窗的标题栏高度摆交通灯', () => {
  const options = bootOptions(null, 'darwin')

  assert.deepEqual(options.trafficLightPosition, { x: 24, y: 34 / 2 - 14 / 2 })
})

test('最大化状态必须与主窗一致，否则会补播一段 zoom 动画', () => {
  assert.equal(bootWindowStartsMaximized({ width: 1440, height: 900, isMaximized: true }), true)
  assert.equal(bootWindowStartsMaximized({ width: 1440, height: 900, isMaximized: false }), false)
  assert.equal(bootWindowStartsMaximized(null), false)
})

test('首帧底色只由深浅决定，两窗共用同一个值', () => {
  assert.equal(bootWindowBackgroundColor(true), '#111111')
  assert.equal(bootWindowBackgroundColor(false), '#f7f7f7')
})
