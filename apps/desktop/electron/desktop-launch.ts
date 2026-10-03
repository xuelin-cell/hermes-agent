import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import { detectRemoteDisplay, isWslEnvironment, resolveLinuxPasswordStore } from './bootstrap-platform'
import { describeDevCdpDecision, resolveDevCdpPort } from './dev-cdp'
import { decideNvidiaEglFallback, parseNvidiaDriverMajor } from './linux-nvidia-egl-fallback'
import {
  decideWindowsSandboxLaunch,
  grantAllApplicationPackagesAcl,
  markerAfterSuccessfulBoot,
  readSandboxMarker,
  type SandboxFallbackReason,
  shouldAttemptAclRepair,
  writeSandboxMarker
} from './windows-sandbox-fallback'
import {
  decideWindowsGpuStackCookieLaunch,
  markerAfterSuccessfulGpuStackCookieBoot,
  readGpuStackCookieMarker,
  writeGpuStackCookieMarker
} from './windows-stack-cookie-fallback'

export interface DesktopLaunchState {
  remoteDisplayReason: string | null
  gpuFallbackActive: boolean
  gpuFallbackSticky: boolean
  sandboxFallbackActive: boolean
  sandboxFallbackSticky: boolean
  sandboxFallbackReason: SandboxFallbackReason
}

let prepared: DesktopLaunchState | null = null

/** 原版平台设置只在 ready 前执行一次；不读取账号 Home、配置或连接。 */
export function prepareDesktopLaunch(): DesktopLaunchState {
  if (prepared) {
    return prepared
  }

  if (app.isReady()) {
    throw new Error('Electron 启动前设置尚未完成。')
  }

  const IS_WINDOWS = process.platform === 'win32'
  const IS_WSL = isWslEnvironment()
  const IS_PACKAGED = app.isPackaged || Boolean(process.env.HERMES_DESKTOP_IS_PACKAGED)
  const DEV_SERVER = process.env.HERMES_DESKTOP_DEV_SERVER

  // Remote displays (SSH X11 forwarding, VNC, RDP) make Chromium's GPU
  // compositor flicker — accelerated layers can't be presented cleanly over the
  // wire, so the window flashes during scroll/streaming/animation. Local
  // Windows/macOS (and WSLg, which renders locally via vGPU) composite on the
  // GPU and never see it. Fall back to software rendering when a remote display
  // is detected; it's rock-steady over the wire and the CPU cost is negligible
  // next to the connection's latency. Must run before app `ready` — these
  // switches only apply pre-launch. Override with HERMES_DESKTOP_DISABLE_GPU
  // (1/true → always disable, 0/false → keep GPU on).
  const launch: DesktopLaunchState = {
    remoteDisplayReason: detectRemoteDisplay(),
    gpuFallbackActive: false,
    gpuFallbackSticky: false,
    sandboxFallbackActive: false,
    sandboxFallbackSticky: false,
    sandboxFallbackReason: 'boot-loop'
  }

  if (launch.remoteDisplayReason) {
    app.disableHardwareAcceleration()
    // Belt-and-suspenders for X11/VNC, where the Viz compositor can still glitch
    // with only --disable-gpu: force compositing onto the CPU too.
    app.commandLine.appendSwitch('disable-gpu-compositing')
    console.log(
      `[hermes] remote display detected (${launch.remoteDisplayReason}); disabling GPU hardware acceleration to prevent flicker`
    )
  }

  // #108047: a local Windows renderer crash loop with STATUS_STACK_BUFFER_OVERRUN
  // (0xC0000409) is recovered by disabling GPU — NOT by dropping the sandbox
  // (that path stays owned by STATUS_BREAKPOINT / #38216). Must run before app
  // `ready`. Skip applying switches when the remote-display block above already
  // did; still honor a sticky per-version marker so Start Menu launches recover.

  if (IS_WINDOWS) {
    const windowsGpuUserData = app.getPath('userData')

    const gpuStackCookieDecision = decideWindowsGpuStackCookieLaunch({
      argv: process.argv,
      marker: readGpuStackCookieMarker(windowsGpuUserData),
      env: process.env,
      appVersion: app.getVersion()
    })

    launch.gpuFallbackActive = gpuStackCookieDecision.enable
    launch.gpuFallbackSticky = gpuStackCookieDecision.nextMarker.state === 'fallback'

    try {
      writeGpuStackCookieMarker(windowsGpuUserData, gpuStackCookieDecision.nextMarker)
    } catch {
      void 0
    }

    if (gpuStackCookieDecision.enable && !launch.remoteDisplayReason) {
      app.disableHardwareAcceleration()
      app.commandLine.appendSwitch('disable-gpu-compositing')
      console.log(
        `[hermes] Windows GPU stack-cookie fallback enabled (${gpuStackCookieDecision.reason}); disabling GPU hardware acceleration (0xC0000409 / #108047)`
      )
    }
  }

  // Renderer debugging port. On for dev-server runs (`hgui` / `npm run dev`) so
  // the CDP tooling in scripts/ can attach; never for a packaged build — see
  // electron/dev-cdp.ts. Must run before app `ready` like the switches above;
  // Chromium binds it at launch.
  const DEV_CDP = resolveDevCdpPort({ env: process.env, isPackaged: IS_PACKAGED, devServer: DEV_SERVER })

  if (DEV_CDP.port) {
    app.commandLine.appendSwitch('remote-debugging-port', String(DEV_CDP.port))
    // Loopback only. Chromium already defaults to 127.0.0.1, but say it out loud
    // so a future edit can't widen it by omission.
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
    console.log(
      `[hermes] renderer debugging on http://127.0.0.1:${DEV_CDP.port} — anything that can reach it ` +
        'can run code in the renderer. HERMES_DESKTOP_CDP_PORT=off to disable.'
    )
  } else {
    const why = describeDevCdpDecision(DEV_CDP)

    if (why) {
      console.warn(`[hermes] ${why}`)
    }
  }

  // WSLg: Chromium blocklists the Mesa vGPU → software compositing → typing lag.
  // /dev/dxg means a real GPU is available; un-blocklist it. Skipped when a remote
  // display already forced software (SSH'd-into-WSL).
  if (IS_WSL && !launch.remoteDisplayReason && fs.existsSync('/dev/dxg')) {
    app.commandLine.appendSwitch('ignore-gpu-blocklist')
    app.commandLine.appendSwitch('enable-gpu-rasterization')
    app.commandLine.appendSwitch('enable-zero-copy')
    console.log('[hermes] WSL GPU passthrough (/dev/dxg) detected; enabling GPU acceleration')
  }

  // #40077: NVIDIA driver 580.x breaks ANGLE's EGL probing (Invalid visual ID),
  // killing the GPU process at startup. Route ANGLE through its SwiftShader
  // backend instead — the app then launches and stays up (CPU rendering, slow
  // but stable). Deliberately NOT disableHardwareAcceleration(): on 580.173.02 +
  // Electron 40 that SIGKILLs the renderer (see the closed #40119). Must run
  // before app `ready` — the switch only applies pre-launch. Override with
  // HERMES_DESKTOP_NVIDIA_SWIFTSHADER (1/true → force on, 0/false → never).
  const NVIDIA_EGL_FALLBACK = decideNvidiaEglFallback({
    driverMajor: parseNvidiaDriverMajor(
      (() => {
        try {
          return fs.readFileSync('/proc/driver/nvidia/version', 'utf8')
        } catch {
          return ''
        }
      })()
    ),
    env: process.env,
    platform: process.platform,
    isWsl: IS_WSL,
    remoteDisplayReason: launch.remoteDisplayReason
  })

  if (NVIDIA_EGL_FALLBACK.enable) {
    app.commandLine.appendSwitch('use-angle', 'swiftshader')
    console.log(
      `[hermes] NVIDIA EGL fallback enabled (${NVIDIA_EGL_FALLBACK.reason}); routing ANGLE ` +
        'through SwiftShader to avoid the NVIDIA 580-series EGL probe crash (#40077). ' +
        'HERMES_DESKTOP_NVIDIA_SWIFTSHADER=0 to opt out.'
    )
  }

  // Linux: point Chromium at the session's keychain backend so safeStorage can
  // encrypt remote gateway tokens (hardening.ts refuses to persist them without
  // it). The value arrives via HERMES_DESKTOP_PASSWORD_STORE, bridged by the
  // `hermes desktop` launcher from detection or `desktop.password_store` in
  // config.yaml. Must run before app `ready` — the switch only applies pre-launch.
  const PASSWORD_STORE = resolveLinuxPasswordStore()

  if (PASSWORD_STORE.warning) {
    console.warn(`[hermes] ${PASSWORD_STORE.warning}`)
  }

  if (PASSWORD_STORE.store) {
    app.commandLine.appendSwitch('password-store', PASSWORD_STORE.store)
    console.log(`[hermes] using password-store backend: ${PASSWORD_STORE.store}`)
  }

  // Windows sandbox / GPU breakpoint crash recovery (#38216).
  //
  // Some hosts (AMD RX 6000 drivers, orphan AppContainer SIDs under %LOCALAPPDATA%,
  // missing S-1-15-2-2 ACEs) kill Chromium's sandboxed GPU/renderer children with
  // 0x80000003. After enough GPU deaths the browser process FATAL-exits before the
  // UI is usable. Must run before app `ready` so `--no-sandbox` applies to child
  // processes. The sticky marker recovers Start Menu / shortcut launches that
  // never go through `hermes desktop`; it is version-scoped so an app update
  // re-probes the sandbox instead of degrading forever.
  //
  // `launch.sandboxFallbackActive` = this process runs without the Chromium
  // sandbox (any cause, including a manual --no-sandbox flag) — guards the
  // relaunch handlers. `launch.sandboxFallbackSticky` = the fallback machinery
  // engaged and the marker must stay `fallback` after a successful boot; a
  // manual flag alone is honored but never made sticky.

  if (IS_WINDOWS) {
    const windowsUserData = app.getPath('userData')
    const priorMarker = readSandboxMarker(windowsUserData)

    // Best-effort ACL repair, only when the last boot aborted or the fallback is
    // engaged — icacls /T recurses the whole install tree, so healthy launches
    // skip it (the installer already granted the ACE at install time). Repair
    // targets the install dir only: granting AppContainer read on userData would
    // expose Hermes sessions/config to every packaged app on the machine.
    if (shouldAttemptAclRepair(priorMarker)) {
      const exeDir = path.dirname(process.execPath)
      const acl = grantAllApplicationPackagesAcl(exeDir, { execFileSync })

      if (acl.ok) {
        console.log(`[hermes] granted ALL APPLICATION PACKAGES RX on ${exeDir} (#38216)`)
      } else if (acl.error && acl.error !== 'missing-target-or-exec') {
        console.warn(`[hermes] AppContainer ACL grant failed on ${exeDir}: ${acl.error}`)
      }
    }

    const sandboxDecision = decideWindowsSandboxLaunch({
      argv: process.argv,
      env: process.env,
      marker: priorMarker,
      appVersion: app.getVersion()
    })

    launch.sandboxFallbackActive = sandboxDecision.enable
    launch.sandboxFallbackSticky = sandboxDecision.nextMarker.state === 'fallback'

    if (sandboxDecision.nextMarker.state === 'fallback' && sandboxDecision.nextMarker.reason) {
      launch.sandboxFallbackReason = sandboxDecision.nextMarker.reason
    }

    if (sandboxDecision.enable && sandboxDecision.reason !== 'already-enabled') {
      app.commandLine.appendSwitch('no-sandbox')
      process.env.ELECTRON_DISABLE_SANDBOX = '1'
      console.log(
        `[hermes] Windows sandbox fallback enabled (${sandboxDecision.reason}); launching with --no-sandbox (#38216)`
      )
    }

    writeSandboxMarker(windowsUserData, sandboxDecision.nextMarker)
  }

  // 保留后台进程优先级；不关闭计时器节流，流式窗口仍由原版动态管理。
  app.commandLine.appendSwitch('disable-renderer-backgrounding')

  prepared = launch

  return launch
}

/** 登录窗已可用或正常退出时清除中途启动标记；原版降级状态继续保留。 */
export function markDesktopLaunchSuccessful(): void {
  if (!prepared || process.platform !== 'win32') {
    return
  }

  try {
    writeSandboxMarker(
      app.getPath('userData'),
      markerAfterSuccessfulBoot({
        fallbackActive: prepared.sandboxFallbackSticky,
        reason: prepared.sandboxFallbackReason,
        appVersion: app.getVersion()
      })
    )
  } catch {
    console.warn('[hermes] 无法记录本次 Chromium 正常启动。')
  }

  try {
    writeGpuStackCookieMarker(
      app.getPath('userData'),
      markerAfterSuccessfulGpuStackCookieBoot({
        fallbackActive: prepared.gpuFallbackSticky,
        appVersion: app.getVersion()
      })
    )
  } catch {
    console.warn('[hermes] 无法记录本次 GPU 正常启动。')
  }
}
