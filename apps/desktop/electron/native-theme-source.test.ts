/**
 * 应用主题持久化的契约测试。
 *
 * 登录壳层跑在聊天运行时之前，但必须和主窗画出同一种深浅——两边靠的就是这个文件
 * 的同一套读写。写进去的值读不回来、或者坏文件把窗口拉成「深色」而不是出厂浅色，
 * 冷启动就会在登录画面和主窗之间出现一次底色跳变。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { isThemeSourceMode, NATIVE_THEME_FILE, readThemeSource, writeThemeSource } from './native-theme-source'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-theme-'))
}

test('写入的应用主题能被另一个进程语义一致地读回', () => {
  const dir = tempDir()

  for (const mode of ['dark', 'light', 'system'] as const) {
    writeThemeSource(dir, mode)
    assert.equal(readThemeSource(dir), mode)
  }
})

test('缺失或损坏的记录按出厂浅色处理', () => {
  const dir = tempDir()

  assert.equal(readThemeSource(dir), 'light')

  fs.writeFileSync(path.join(dir, NATIVE_THEME_FILE), '{not json', 'utf8')
  assert.equal(readThemeSource(dir), 'light')

  fs.writeFileSync(path.join(dir, NATIVE_THEME_FILE), JSON.stringify({ themeSource: 'dim' }), 'utf8')
  assert.equal(readThemeSource(dir), 'light')
})

test('只有三种主题模式能通过校验', () => {
  for (const mode of ['dark', 'light', 'system']) {
    assert.equal(isThemeSourceMode(mode), true)
  }

  for (const bad of [undefined, null, '', 'auto', 'DARK', 1]) {
    assert.equal(isThemeSourceMode(bad), false)
  }
})
