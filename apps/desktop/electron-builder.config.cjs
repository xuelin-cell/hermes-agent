// THE electron-builder configuration — the whole thing, one file. There is
// no "build" field in package.json: run-electron-builder.mjs always passes
// --config for this file, so a stray package.json field would be silently
// ignored anyway, and splitting the config across JSON + this overlay is
// how the two halves drift.
//
// A .cjs module (not JSON) so the variant is decided at require time:
// HERMES_DESKTOP_VARIANT=light builds "Hermes Light". The whole config
// derives from that one flag.
// @ts-check
'use strict'

const path = require('node:path')
const feedContract = require('./update-feed.cjs')
const { resolveStamp } = require('./scripts/write-build-stamp.mjs')
const { createMacSigner } = require('./scripts/mac-sign.mjs')

const {
  light,
  store,
  storeMsix,
  displayName,
  appId,
  appNamePascal,
  artifactNamePascal,
  windowsExecutableName,
  channel,
  msixAppIdWithOrg
} = require('./product-identity.cjs')

// `storeMsix` is optional on the identity type but guaranteed present when
// `store` is true (product-identity.cjs spreads it only in that branch).
// The `store` flag is typed `boolean` in the identity, so checkJs cannot
// correlate the two; `mustStoreMsix` is the single assertion point and the
// invariant lives in product-identity.cjs:33-34/58-68.
/** @type {NonNullable<typeof storeMsix> | undefined} */
const storeMsixWhenStore = storeMsix
const releaseBuild = Boolean(process.env.HERMES_PAYLOAD_TAG)
const appInstallerManaged = ['bundled', 'light', 'store'].includes(process.env.HERMES_DESKTOP_VARIANT || '')

/**
 * The store MSIX packaging identity. Callers must only invoke this when
 * `store` is true (see the invariant note above).
 * @param {NonNullable<typeof storeMsix> | undefined} value
 * @returns {NonNullable<typeof storeMsix>}
 */
function mustStoreMsix(value) {
  return /** @type {NonNullable<typeof storeMsix>} */ (value)
}

// The out-of-store MSIX publisher (ATS cert subject) — single source, shared
// with the .appinstaller generator so the manifest and the App Installer can
// never drift (see scripts/msix-shared.mjs).
const { OUT_OF_STORE_PUBLISHER, channelBuildRequest, stageChannelManifest } = require('../../scripts/msix-shared.mjs')
const channelRequest = channelBuildRequest()

/** @typedef {import("app-builder-lib").Configuration} Configuration */

const [owner, repo] = (process.env.GITHUB_REPOSITORY || 'NousResearch/hermes-agent').split('/')
if (!owner || !repo) {
  throw new Error(`invalid GITHUB_REPOSITORY ${process.env.GITHUB_REPOSITORY}`)
}
const electronVersion = require('./package.json').devDependencies.electron
if (!/^\d+\.\d+\.\d+$/.test(electronVersion)) {
  throw new Error(`invalid electron version ${electronVersion} in package.json`)
}

const macFeed = channelRequest ? null : feedContract.darwinFeed(channel === 'canary' || channel === 'light-canary' ? 'canary' : 'stable', light)
// The public update origin. CLOUDFLARE_R2_PUBLIC_URL still wins so a fork or
// a CI lane can point at its own bucket; the default is the Unicom OBS tree
// the Windows installer and the desktop clients are documented against.
const DEFAULT_PUBLIC_URL = 'https://obs-nmhhht6.cucloud.cn/model-extend-public/installer/unihermes'
const publicUrl = feedContract.feedBaseUrl(process.env.CLOUDFLARE_R2_PUBLIC_URL) ?? feedContract.feedBaseUrl(DEFAULT_PUBLIC_URL)

// A self-managed NSIS build updates through electron-updater, so it publishes
// a feed at the same `releases/win32/...` layout the MSIX descriptor uses.
// desktop.py derives HERMES_WINDOWS_FORMAT and injects it into this process.
const windowsUpdater = process.env.HERMES_WINDOWS_UPDATE === 'electron-updater'
const windowsFormat = process.env.HERMES_WINDOWS_FORMAT || (appInstallerManaged ? 'msix' : 'nsis')
const winFeed = channel && windowsUpdater
  ? feedContract.win32Feed(channel === 'canary' || channel === 'light-canary' ? 'canary' : 'stable', light)
  : null

/** @satisfies {Configuration} */
module.exports = {
  electronVersion,
  appId,
  productName: displayName,
  executableName: displayName,
  protocols: [
    {
      name: `${displayName} Protocol`,
      schemes: ['hermes']
    }
  ],
  // A store build is archived, never served to a feed — prefix its artifact
  // so it can't collide with the out-of-store MSIX of the same tag/arch, and
  // the release pipeline can keep the two apart.
  artifactName: `${store ? 'Store-' : ''}${artifactNamePascal}-\${version}-\${os}-\${arch}.\${ext}`,
  icon: 'assets/icon',
  // The electron-updater feed. CI builds set CLOUDFLARE_R2_PUBLIC_URL (the R2
  // public bucket / custom domain) and publish there — the feed yml, blockmaps
  // and installers all live in the same flat R2 bucket, and electron-updater
  // resolves the yml's relative artifact paths against it. Builds without the
  // var (local, or a fork without the R2 vars) keep the github provider, which
  // is exactly today's behavior. The store build has no feed at all (the Store
  // owns its distribution and updates).
  publish: channelRequest ? null : !channel
    ? null
    : [
        publicUrl
          ? { provider: 'generic', url: publicUrl, channel }
          : { provider: 'github', owner, repo, channel }
      ],
  extraMetadata: {
    name: appNamePascal,
    // Electron bootstrap reads package.productName before main.ts. Keep the
    // shipped stable default, but isolate nonstable userData from first access.
    ...(channelRequest || appNamePascal !== artifactNamePascal ? { productName: displayName } : {}),
    desktopName: appId
  },
  directories: {
    output: 'release'
  },
  files: ['dist/**', '!dist/python-plugins/**', 'assets/**', '!assets/uniagentgate-plugin/**', 'public/**', 'package.json'],
  beforeBuild: channelRequest ? async () => {
    await require(path.join(__dirname, 'scripts/before-build.mjs')).default()
    stageChannelManifest(__dirname, channelRequest)
    return false
  } : 'scripts/before-build.mjs',
  beforePack: 'scripts/before-pack.mjs',
  // The exe identity stamp runs here, on the pristine electron.exe, because
  // ASAR integrity rewrites the PE later and rcedit cannot commit to that
  // rewritten file (#105629). afterPack keeps the signing/payload work.
  afterExtract: 'scripts/after-extract.mjs',
  afterPack: 'scripts/after-pack.mjs',
  ...(process.platform === 'darwin' ? { afterSign: 'scripts/notarize.mjs' } : {}),
  extraResources: [
    {
      // desktop-mt: electron-builder always drops node_modules at the root of an
      // extraResources source (app-builder-lib util/filter.js), so copy from the
      // parent: the dependencies then sit one level down and reach resources/open-connector.
      from: 'services',
      to: '.',
      filter: ['src/**', 'catalog/**', 'migrations/**', 'node_modules/**', 'desktop-entry.mjs', 'package.json', 'LICENSE.txt', 'NOTICE.md', 'README.desktop.md']
        .map(pattern => `open-connector/${pattern}`)
    },
    {
      from: 'dist/python-plugins',
      to: 'python-plugins',
      filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc']
    },
    {
      from: 'build/install-stamp.json',
      to: 'install-stamp.json'
    },
    ...(['bundled', 'store'].includes(process.env.HERMES_DESKTOP_VARIANT || '')
      ? [{ from: 'build/agent-payload', to: 'agent-payload' }]
      : []),
    {
      from: 'assets/icon.ico',
      to: 'icon.ico'
    }
  ],
  asar: {
    unpack: ['**/*.node', '**/prebuilds/**', 'dist/**']
  },
  mac: {
    // The afterSign hook owns notarization, including keychain-profile builds.
    notarize: false,
    // The packaged client reads this generated app-update.yml by default.
    publish: channelRequest?.receiverCandidate
      ? [{ provider: 'generic', url: `${channelRequest.publicBase}/releases/darwin/stable/`, channel: 'stable' }]
      : channelRequest
      ? [{ provider: 'generic', url: `${channelRequest.publicBase}/releases/channel-builds/${channelRequest.buildId}/darwin/`, channel: 'latest' }]
      : publicUrl && channel && macFeed
      ? [{ provider: 'generic', url: `${publicUrl}/${macFeed.directory}/`, channel: macFeed.channel }]
      : null,
    category: 'public.app-category.developer-tools',
    extendInfo: {
      CFBundleDisplayName: displayName,
      CFBundleExecutable: displayName,
      CFBundleName: displayName,
      LSRequiresNativeExecution: true,
      NSAudioCaptureUsageDescription: `${displayName} uses audio capture for voice conversations.`,
      NSCameraUsageDescription: `${displayName} uses the camera when a plugin or feature you enable requests it.`,
      NSMicrophoneUsageDescription: `${displayName} uses the microphone for voice input and voice conversations.`,
      NSCalendarsUsageDescription: `${displayName} needs access to Calendar to provide requested meeting and scheduling support.`,
      NSCalendarsFullAccessUsageDescription: `${displayName} needs full access to Calendar to read and manage events when explicitly requested.`,
      NSRemindersUsageDescription: `${displayName} needs access to Reminders to provide requested personal-assistant and scheduling support.`,
      NSRemindersFullAccessUsageDescription: `${displayName} needs full access to Reminders to read and manage reminders when explicitly requested.`,
      NSScreenCaptureUsageDescription: `${displayName} captures the screen when you ask the agent to screenshot or record it.`,
      NSLocalNetworkUsageDescription: `${displayName} connects to devices on your local network when a plugin or feature you enable requests it.`,
      NSAppleMusicUsageDescription: `${displayName} accesses your music library when a plugin or feature you enable requests it.`,
      NSContactsUsageDescription: `${displayName} uses Contacts access when you ask it to read or update your address book.`,
      NSAppleEventsUsageDescription: `${displayName} uses Apple Events to automate apps you explicitly ask it to control.`
    },
    target: ['dmg', 'zip'],
    sign: createMacSigner(require('./scripts/mac-sign-policy.cjs'))
  },
  dmg: {
    // Avoid the failing optional APFS shrink pass; keep compressed conversion.
    shrink: false,
    title: 'Hermes Agent Installer',
    // A prebuilt .tiff on purpose, not a PNG plus a @2x sibling: dmg-builder's
    // PNG path runs `tiffutil -cathidpicheck`, which on macOS 26 rewrites both
    // frames to 72 dpi and silently drops the 2x representation. A .tiff is
    // handed to dmgbuild untouched (dmg-builder/dist/dmgUtil.js), and living
    // outside assets/ keeps it out of the app bundle via the `files` whitelist.
    background: 'packaging/nous-dmg-2b.tiff',
    iconSize: 96,
    iconTextSize: 11,
    window: {
      width: 660,
      height: 400
    },
    contents: [
      {
        x: 253,
        y: 238,
        type: 'file'
      },
      {
        x: 512,
        y: 235,
        type: 'link',
        path: '/Applications'
      }
    ]
  },
  win: {
    executableName: windowsExecutableName,
    legalTrademarks: displayName,
    target: windowsFormat === 'msix' ? ['msix'] : windowsFormat === 'nsis-web' ? ['nsis-web'] : ['nsis'],
    // electron-updater reads this baked copy for the feed origin. Only the
    // self-managed NSIS build publishes one; an MSIX install is updated by
    // the App Installer descriptor instead.
    ...(winFeed && publicUrl
      ? { publish: [{ provider: 'generic', url: `${publicUrl}/${winFeed.directory}/`, channel: winFeed.channel }] }
      : {}),
    ...windowsSigning()
  },
  nsis: {
    ...(!light && !store ? { artifactName: `UniWorkBundled-\${version}-${resolveStamp().commit.slice(0, 7)}.exe` } : {}),
    oneClick: false,
    perMachine: true,
    // `perMachine` + `oneClick: false` is the one pair NsisTarget does not
    // flag `isAdminRightsRequired` for unless this is explicitly set, and that
    // flag is what makes electron-updater elevate through resources\elevate.exe.
    // Without it the non-elevated app spawns the admin-manifested installer,
    // CreateProcess fails with ERROR_ELEVATION_REQUIRED, and the update
    // silently never installs — the app relaunches on the old version.
    packElevateHelper: true,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    // desktop-mt: 直接解到安装目录，省掉先解到临时目录再复制的那一遍（见 nsis/installer.nsh）。
    include: 'nsis/installer.nsh'
  },
  nsisWeb: {
    // Only the web installer embeds a blockmap: its .exe is a small bootstrapper
    // and the app payload is a separately published .7z carrying the block index.
    // That is the only NSIS shape electron-updater can download differentially;
    // a full nsis .exe ships a standalone .blockmap that NsisUpdater never reads.
    // It inherits nsis.* (oneClick/perMachine/packElevateHelper/include).
  },
  msix: {
    // A store build uses the Partner Center packaging identity (the Store
    // re-signs + rewrites the publisher on submission); everything else uses
    // the out-of-store ATS-cert identity.
    identityName: store ? mustStoreMsix(storeMsixWhenStore).identityName : msixAppIdWithOrg,
    applicationId: appNamePascal,
    displayName,
    publisher: store ? mustStoreMsix(storeMsixWhenStore).publisher : OUT_OF_STORE_PUBLISHER,
    publisherDisplayName: store ? mustStoreMsix(storeMsixWhenStore).publisherDisplayName : 'Nous Research',
    // The native quad is the build time (scripts/msix-shared.mjs::nativeQuad),
    // baked into the manifest template, so the builder's own build-number
    // override would stamp a second, conflicting version.
    setBuildNumber: false,
    // Store versions are baked into a build-time template. App semver and
    // artifact filenames stay unchanged; the Store reserves revision zero.
    // Floor Windows 11 22H2. Below build 18307 the manifest schema caps
    // AppExtension Name at 39 chars and Microsoft's own
    // "com.microsoft.windows.copilotkeyprovider" is 40 (makeappx
    // 0x80080204 — A/B-verified against the 26100 kit; 18307 exactly
    // still failed on it, 22621 passes), and 22621 is the documented
    // Copilot hardware key floor anyway.
    minVersion: '10.0.22621.0',
    maxVersionTested: '10.0.26100.0',
    // Static path: the file itself is written by scripts/before-build.mjs at
    // build time (see the comment on the hook) — never at config require
    // time, so typecheck/test imports don't touch the filesystem.
    customExtensionsPath: 'build/msix-extensions.xml',
    customManifestPath: store ? 'build/store-msix-manifest.xml'
      : releaseBuild || channelRequest || appNamePascal !== artifactNamePascal
        ? 'build/msix-manifest.xml' : 'assets/msix-manifest.xml',
    // Hermes state is deliberately shared with unpackaged CLI/gateway
    // processes. Pair the manifest's disabled virtualization properties with
    // the restricted capability that permits unvirtualized AppData/HKCU writes.
    capabilities: ['unvirtualizedResources'],
    showNameOnTiles: true
  },
  linux: {
    category: 'Development',
    maintainer: 'Nous Research <support@nousresearch.com>',
    synopsis: light
      ? 'Remote-only desktop client for Hermes Agent.'
      : 'Native desktop shell for Hermes Agent.',
    target: ['AppImage']
  }
}

if (channelRequest) {
  Object.assign(module.exports, { buildVersion: channelRequest.version })
  Object.assign(module.exports.extraMetadata, {
    version: channelRequest.version,
    shortVersion: channelRequest.windowsVersion,
    shortVersionWindows: channelRequest.windowsVersion
  })
  Object.assign(module.exports.mac, {
    bundleVersion: channelRequest.version,
    bundleShortVersion: channelRequest.version
  })
}

// MSIX build-time staging (build/appx icons + build/msix-extensions.xml)
// lives in scripts/before-build.mjs — an electron-builder lifecycle hook —
// NOT here at require time, so importing this config for typecheck/tests
// never writes to the filesystem.

// Azure Trusted Signing. The hook signs the .msix package itself and the
// product exe (after electron-builder's rcedit — the batch in afterPack runs
// too early for the exe); every other payload binary is batch-signed in
// afterPack via scripts/batch-sign-binaries.mjs, which this hook acknowledges
// with `true` so electron-builder never re-signs one-by-one. The package
// signature is all Windows install validation checks; inner Authenticode
// covers SmartScreen/WDAC tree scans. See batch-sign-binaries.mjs for the
// ordering contract.

function windowsSigning() {
  if (!process.env.AZURE_SIGN_ENDPOINT || !process.env.AZURE_CLIENT_ID) {
    return {}
  }
  return {
    sign: {
      type: 'signtool',
      sign: './scripts/batch-sign-binaries.mjs',
      signingHashAlgorithms: ['sha256'],
      publisherName: process.env.AZURE_SIGN_PUBLISHER
    }
  }
}
