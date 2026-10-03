import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Menu, protocol } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { readSandboxMarker } from './windows-sandbox-fallback'

const fixture = vi.hoisted(() => ({
  ready: false,
  userData: '',
  app: {
    isReady: (): boolean => fixture.ready,
    isPackaged: false,
    getPath: (): string => fixture.userData,
    getVersion: (): string => 'fixture-version',
    disableHardwareAcceleration: vi.fn(),
    commandLine: { appendSwitch: vi.fn() }
  }
}))

vi.mock('electron', () => ({
  app: fixture.app,
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  Menu: { setApplicationMenu: vi.fn() }
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fixture.ready = false
  fixture.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mt-launch-'))
  vi.stubEnv('HERMES_DESKTOP_DISABLE_GPU', '1')
  vi.stubEnv('HERMES_DESKTOP_CDP_PORT', 'off')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

it('启动前规则只执行一次，登录窗口成功加载不被当作中途崩溃', async () => {
  const { prepareDesktopLaunch, markDesktopLaunchSuccessful } = await import('./desktop-launch')
  const launch = prepareDesktopLaunch()
  expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledOnce()
  expect(Menu.setApplicationMenu).toHaveBeenCalledExactlyOnceWith(null)
  expect(fixture.app.disableHardwareAcceleration).toHaveBeenCalledOnce()
  expect(fixture.app.commandLine.appendSwitch).toHaveBeenCalledWith('disable-renderer-backgrounding')
  expect(fixture.app.commandLine.appendSwitch).not.toHaveBeenCalledWith('remote-debugging-port', expect.anything())
  const calls = fixture.app.commandLine.appendSwitch.mock.calls.length
  fixture.ready = true
  expect(prepareDesktopLaunch()).toBe(launch)
  expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledOnce()
  expect(fixture.app.commandLine.appendSwitch).toHaveBeenCalledTimes(calls)
  markDesktopLaunchSuccessful()

  if (process.platform === 'win32') {
    expect(readSandboxMarker(fixture.userData)?.state).toBe('ok')
  }
})

it('错过启动前阶段时明确拒绝，不静默执行无效的 Chromium 设置', async () => {
  const { prepareDesktopLaunch } = await import('./desktop-launch')
  fixture.ready = true
  expect(prepareDesktopLaunch).toThrow('Electron 启动前')
  expect(fixture.app.disableHardwareAcceleration).not.toHaveBeenCalled()
  expect(fixture.app.commandLine.appendSwitch).not.toHaveBeenCalled()
  expect(protocol.registerSchemesAsPrivileged).not.toHaveBeenCalled()
  expect(fs.readdirSync(fixture.userData)).toEqual([])
})
