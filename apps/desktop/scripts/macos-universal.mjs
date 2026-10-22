import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import * as asar from '@electron/asar'
import { makeUniversalApp } from '@electron/universal'
import plist from 'plist'
import { isMain } from './utils.mjs'
import { rehashPayloadDigests } from './payload-digests.mjs'

const require = createRequire(import.meta.url)
const policy = require('./mac-sign-policy.cjs')
const architectures = ['x64', 'arm64']

/** 校验原生构建身份和最小运行契约，不接受只有 Electron 外壳的输入。 */
export function inspectInput(app, arch) {
  const contents = path.join(app, 'Contents')
  const resources = path.join(contents, 'Resources')
  const stamp = JSON.parse(fs.readFileSync(path.join(resources, 'install-stamp.json'), 'utf8'))
  const info = plist.parse(fs.readFileSync(path.join(contents, 'Info.plist'), 'utf8'))
  if (stamp.dirty !== false || !/^[0-9a-f]{40}$/.test(stamp.commit) || stamp.payload !== 'bundled' || !stamp.runtime || stamp.desktopRuntimeLayout !== 1) {
    throw new Error('Input must be a clean committed bundled build')
  }
  // 本入口只交付内部测试包，避免将临时签名包接入正式自动更新通道。
  if (stamp.updateMechanism !== 'external') throw new Error('Universal internal builds require external updates')
  const payload = path.join(resources, 'agent-payload')
  for (const file of ['manifest.json', 'tools/facts.json']) {
    if (!fs.existsSync(path.join(payload, file))) throw new Error('Input lacks payload integrity metadata')
  }
  for (const relative of [stamp.runtime.repoDir, stamp.runtime.toolsDir, stamp.runtime.storePython, stamp.runtime.sitePackages, ...Object.values(stamp.runtime.commands)]) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || !fs.existsSync(path.join(payload, relative))) {
      throw new Error('Input payload launch contract is incomplete')
    }
  }
  for (const binary of [path.join(contents, 'MacOS', info.CFBundleExecutable), path.join(payload, stamp.runtime.storePython)]) {
    const actual = execFileSync('/usr/bin/lipo', ['-archs', binary], { encoding: 'utf8' }).trim()
    if (actual !== (arch === 'x64' ? 'x86_64' : 'arm64')) throw new Error(`Expected native ${arch} input: ${binary}`)
  }
  const pkg = JSON.parse(asar.extractFile(path.join(resources, 'app.asar'), 'package.json').toString())
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(pkg.version) || info.CFBundleExecutable !== 'UniWork') throw new Error('Unexpected product name or version')
  if (!fs.existsSync(path.join(resources, 'open-connector', 'node_modules'))) throw new Error('Input lacks OpenConnector')
  return { stamp, info, pkg, resources }
}

/** 重新生成 ESM 入口，兼容当前应用模块类型，并更新 Electron 的 ASAR 完整性声明。 */
async function writeLauncher(app, metadata, temporary) {
  const resources = path.join(app, 'Contents', 'Resources')
  const entry = path.join(temporary, 'launcher')
  fs.mkdirSync(entry)
  const mains = Object.fromEntries(architectures.map(arch => [arch, metadata[arch].pkg.main]))
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ ...metadata.arm64.pkg, type: 'module', main: 'index.mjs' }))
  fs.writeFileSync(path.join(entry, 'index.mjs'), `import { app } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const mains = ${JSON.stringify(mains)}
if (!Object.hasOwn(mains, process.arch)) throw new Error('Unsupported application architecture')
const root = path.join(path.dirname(app.getAppPath()), 'app-' + process.arch + '.asar')
app.setAppPath(root)
Object.defineProperty(process, 'uniworkUniversalLayout', { value: Object.freeze({ commit: ${JSON.stringify(metadata.arm64.stamp.commit)}, arch: process.arch }) })
await import(pathToFileURL(path.join(root, mains[process.arch])).href)
`)
  const archive = path.join(resources, 'app.asar')
  await asar.createPackage(entry, archive)
  const infoFile = path.join(app, 'Contents', 'Info.plist')
  const info = plist.parse(fs.readFileSync(infoFile, 'utf8'))
  info.ElectronAsarIntegrity = Object.fromEntries(['app.asar', 'app-arm64.asar', 'app-x64.asar'].map(name => [
    `Resources/${name}`, { algorithm: 'SHA256', hash: createHash('sha256').update(asar.getRawHeader(path.join(resources, name)).headerString).digest('hex') }
  ]))
  fs.writeFileSync(infoFile, plist.build(info))
}

/** 移除副本中各层旧资源封存，合并后统一重签；不跟随目录符号链接。 */
function removeSeals(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.name === '_CodeSignature') fs.rmSync(file, { recursive: true, force: true })
    else if (entry.isDirectory()) removeSeals(file)
  }
}

/** 在独立副本上合并，保留两套原生载荷；绝不修改输入应用或复用其外层签名。 */
export async function assembleUniversal({ x64, arm64, out, work }) {
  const inputs = { x64: path.resolve(x64), arm64: path.resolve(arm64) }
  for (const input of Object.values(inputs)) {
    for (const output of [out, work]) {
      const relative = path.relative(input, path.resolve(output))
      if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('Output and work directories must be outside input applications')
      }
    }
  }
  const metadata = Object.fromEntries(architectures.map(arch => [arch, inspectInput(inputs[arch], arch)]))
  // 两份输入必须来自相同产品、源码与依赖配置。
  const identity = value => JSON.stringify([
    value.stamp.commit, value.stamp.baseVersion, value.stamp.bundleEnv, value.stamp.channelBuild,
    value.info.CFBundleIdentifier, value.info.CFBundleExecutable, value.info.CFBundleShortVersionString, value.info.CFBundleVersion,
    value.pkg.version, value.pkg.name, value.pkg.main
  ])
  if (identity(metadata.x64) !== identity(metadata.arm64)) throw new Error('Input commit, version or product identity differs')
  if (fs.existsSync(out)) throw new Error('Output already exists; choose a new output directory')
  fs.mkdirSync(work, { recursive: true })
  const temporary = fs.mkdtempSync(path.join(work, 'universal-'))
  try {
    const copies = {}
    for (const arch of architectures) {
      const copy = path.join(temporary, `${arch}.app`)
      execFileSync('/bin/cp', ['-R', inputs[arch], copy])
      copies[arch] = copy
      const resources = path.join(copy, 'Contents', 'Resources')
      for (const name of ['agent-payload', 'open-connector']) {
        fs.renameSync(path.join(resources, name), path.join(temporary, `${name}-${arch}`))
      }
      fs.rmSync(path.join(resources, 'install-stamp.json'))
      removeSeals(copy)
    }
    // 所有 unpacked 内容随各自 ASAR 保留，不能把不同架构的主进程或原生模块混用。
    await makeUniversalApp({ x64AppPath: copies.x64, arm64AppPath: copies.arm64,
      outAppPath: out, mergeASARs: false, singleArchFiles: '**/*' })
    const resources = path.join(out, 'Contents', 'Resources')
    // 极少数输入 ASAR 相同也可能含不同 unpacked 原生模块，仍显式保留两套归档。
    for (const arch of architectures) {
      for (const suffix of ['', '.unpacked']) {
        const target = path.join(resources, `app-${arch}.asar${suffix}`)
        if (!fs.existsSync(target)) fs.cpSync(path.join(inputs[arch], 'Contents', 'Resources', `app.asar${suffix}`), target, { recursive: true, verbatimSymlinks: true })
      }
      for (const name of ['agent-payload', 'open-connector']) {
        fs.mkdirSync(path.join(resources, name), { recursive: true })
        fs.renameSync(path.join(temporary, `${name}-${arch}`), path.join(resources, name, `darwin-${arch}`))
      }
    }
    fs.rmSync(path.join(resources, 'app.asar.unpacked'), { recursive: true, force: true })
    fs.writeFileSync(path.join(resources, 'install-stamp.json'), JSON.stringify(metadata.arm64.stamp, null, 2))
    fs.writeFileSync(path.join(resources, 'universal-layout.json'), JSON.stringify({ schema: 1, commit: metadata.arm64.stamp.commit }))
    await writeLauncher(out, metadata, temporary)
    return metadata.arm64
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

/** 对两套载荷统一临时签名，摘要刷新后才封存外层应用。 */
export async function signUniversalApp(app) {
  const { sign } = await import('@electron/osx-sign')
  await sign({ app, identity: '-', identityValidation: false, platform: 'darwin', type: 'distribution',
    gatekeeperAssess: false, ignore: policy.ignore, batchCodesignCalls: false,
    optionsForFile: file => {
      if (file === app) {
        for (const arch of architectures) rehashPayloadDigests(path.join(app, 'Contents', 'Resources', 'agent-payload', `darwin-${arch}`))
      }
      return { hardenedRuntime: true, entitlements: file === app ? policy.entitlements : policy.entitlementsInherit }
    }
  })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}

/** 从最终已签名应用生成单个 DMG，并检查镜像校验和后才报告完成。 */
export function createUniversalDmg(app, destination, version) {
  const stage = path.join(destination, 'dmg-content')
  fs.mkdirSync(stage)
  fs.renameSync(app, path.join(stage, 'UniWork.app'))
  fs.symlinkSync('/Applications', path.join(stage, 'Applications'))
  const dmg = path.join(destination, `UniWorkBundled-${version}-mac-universal.dmg`)
  execFileSync('/usr/bin/hdiutil', ['create', '-volname', 'UniWork', '-srcfolder', stage, '-format', 'UDZO', dmg], { stdio: 'inherit' })
  fs.renameSync(path.join(stage, 'UniWork.app'), app)
  fs.rmSync(stage, { recursive: true })
  execFileSync('/usr/bin/hdiutil', ['verify', dmg], { stdio: 'inherit' })
  return dmg
}

/** 合并后签署所有原生文件，刷新两套载荷摘要，再生成单个可安装 DMG。 */
async function main(args) {
  if (process.platform !== 'darwin') throw new Error('Run on macOS')
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--x64-app', '--arm64-app', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: --x64-app PATH --arm64-app PATH --out NEW_DIRECTORY')
    options[args[i]] = path.resolve(args[i + 1])
  }
  if (Object.keys(options).length !== 3) throw new Error('Both native apps and a new output directory are required')
  const destination = options['--out']
  fs.mkdirSync(destination) // 不覆盖旧产物或输入目录。
  const app = path.join(destination, 'UniWork.app')
  const metadata = await assembleUniversal({ x64: options['--x64-app'], arm64: options['--arm64-app'], out: app, work: destination })
  await signUniversalApp(app)
  const dmg = createUniversalDmg(app, destination, metadata.pkg.version)
  console.log(`Universal DMG: ${dmg}`)
}

if (isMain(import.meta.url)) await main(process.argv.slice(2))
