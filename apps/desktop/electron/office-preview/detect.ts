import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  OFFICE_CONVERTER_ORDER,
  type OfficeConverter,
  type OfficeDocumentKind
} from '../../../shared/src/office-preview'
import { hiddenWindowsChildOptions } from '../windows-child-options'
import { expandWindowsEnvRefs } from '../windows-user-env'

export type OfficeRegistryView = '32' | '64'

export interface OfficeComRegistration {
  kind: OfficeDocumentKind
  progId: string
  registryView: OfficeRegistryView
  command: string
  serverExecutable?: string
}

export interface OfficeComProgram extends OfficeComRegistration {
  provider: Exclude<OfficeConverter, 'libreoffice'>
  executable: string
}

export interface OfficeCliProgram {
  provider: 'libreoffice'
  executable: string
}

export type OfficeProgram = OfficeComProgram | OfficeCliProgram
export type OfficeDetection = Record<OfficeDocumentKind, readonly OfficeProgram[]>

export interface OfficeDetectionDeps {
  readComRegistrations: () => Promise<OfficeComRegistration[]>
  /** 可以是异步的；探测并行检查所有候选，不在主进程同步等待磁盘或网络盘。 */
  isFile: (filePath: string) => boolean | Promise<boolean>
  env: NodeJS.ProcessEnv
}

const COM_PROGIDS: Readonly<Record<OfficeDocumentKind, readonly string[]>> = {
  word: ['KWPS.Application', 'KWPS.Application.6', 'WPS.Application', 'Word.Application'],
  slides: ['KWPP.Application', 'KWPP.Application.6', 'WPP.Application', 'PowerPoint.Application'],
  sheet: ['KWET.Application', 'KET.Application', 'KET.Application.6', 'ET.Application', 'Excel.Application']
}

const MS_EXECUTABLES: Record<OfficeDocumentKind, string> = {
  word: 'winword.exe',
  slides: 'powerpnt.exe',
  sheet: 'excel.exe'
}

export const WPS_EXECUTABLES: Record<OfficeDocumentKind, readonly string[]> = {
  word: ['wps.exe'],
  slides: ['wpp.exe', 'wps.exe'],
  sheet: ['et.exe', 'wps.exe']
}

// 用系统注册表 API 一次只读查询两种视图，输出 UTF-8，不激活 COM 或打开文档。
const REGISTRY_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# 只读取指定值，并及时关闭句柄；不存在的键不是探测异常。
function Read-OfficeValue($root, $subkey, $name = '') {
  $key = $root.OpenSubKey($subkey, $false)
  if ($null -eq $key) { return $null }
  try { return $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { $key.Dispose() }
}
$requests = ConvertFrom-Json $env:OFFICE_PREVIEW_PROGIDS
$results = @()
$views = if ([Environment]::Is64BitOperatingSystem) { @('Registry64', 'Registry32') } else { @('Registry32') }
foreach ($view in $views) {
  $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot, $view)
  try {
    foreach ($request in $requests) {
      $progId = $request.progId
      $clsid = Read-OfficeValue $root ($progId + '\CLSID')
      if (-not $clsid) {
        $current = Read-OfficeValue $root ($progId + '\CurVer')
        if ($current -and $current -match '^[a-zA-Z0-9_.-]+$') {
          $progId = $current
          $clsid = Read-OfficeValue $root ($progId + '\CLSID')
        }
      }
      if (-not $clsid -or $clsid -notmatch '^\{[0-9a-fA-F-]{36}\}$') { continue }
      $classKey = 'CLSID\' + $clsid
      if (Read-OfficeValue $root $classKey 'LocalService') { continue }
      $serverKey = $classKey + '\LocalServer32'
      $command = Read-OfficeValue $root $serverKey
      $executable = Read-OfficeValue $root $serverKey 'ServerExecutable'
      if ($command -or $executable) {
        $results += [pscustomobject]@{
          kind = $request.kind; progId = $progId; registryView = $view.Substring(8)
          command = [string]$command; serverExecutable = [string]$executable
        }
      }
    }
  } finally { $root.Dispose() }
}
ConvertTo-Json -InputObject @($results) -Compress
`

/** Windows 上批量读取真实 COM 注册，失败上抛，不把查询失败缓存成未安装。 */
export async function readOfficeComRegistrations(): Promise<OfficeComRegistration[]> {
  if (process.platform !== 'win32') {
    return []
  }

  const requests = Object.entries(COM_PROGIDS).flatMap(([kind, ids]) => ids.map(progId => ({ kind, progId })))

  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(REGISTRY_PROBE, 'utf16le').toString('base64')],
      hiddenWindowsChildOptions({
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        env: { ...process.env, OFFICE_PREVIEW_PROGIDS: JSON.stringify(requests) }
      }),
      (error, output) => (error ? reject(error) : resolve(output))
    )

    child.stdin?.end()
  })

  const registrations: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''))

  if (!Array.isArray(registrations)) {
    throw new Error('Invalid Office registry probe result')
  }

  return registrations as OfficeComRegistration[]
}

/** 按平台生成候选路径：先 PATH，再常见安装位置，不隐式搜索当前工作目录。 */
export function libreOfficeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, userHome: string): string[] {
  const windows = platform === 'win32'
  const paths = windows ? path.win32 : path.posix
  const executable = windows ? 'soffice.exe' : 'soffice'
  // Linux 发行版常只在 PATH 里放 libreoffice 这个启动名。
  const names = platform === 'linux' ? [executable, 'libreoffice'] : [executable]

  const candidates = (env.PATH || env.Path || '')
    .split(windows ? ';' : ':')
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(entry => paths.isAbsolute(entry))
    .flatMap(entry => names.map(name => paths.join(entry, name)))

  if (windows) {
    for (const root of [
      env.ProgramW6432,
      env.ProgramFiles || 'C:\\Program Files',
      env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    ]) {
      if (root) {
        candidates.push(paths.join(root, 'LibreOffice', 'program', executable))
      }
    }

    if (env.LOCALAPPDATA) {
      candidates.push(paths.join(env.LOCALAPPDATA, 'Programs', 'LibreOffice', 'program', executable))
    }
  } else {
    candidates.push('/usr/bin/soffice', '/usr/local/bin/soffice', '/opt/libreoffice/program/soffice')

    if (platform === 'linux') {
      // 发行版包、Snap 和 Flatpak（系统级与用户级）的常见位置。
      candidates.push(
        '/usr/lib/libreoffice/program/soffice',
        '/usr/lib64/libreoffice/program/soffice',
        '/snap/bin/libreoffice',
        '/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice',
        paths.join(userHome, '.local/share/flatpak/exports/bin/org.libreoffice.LibreOffice')
      )
    }

    if (platform === 'darwin') {
      candidates.push(
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        paths.join(userHome, 'Applications/LibreOffice.app/Contents/MacOS/soffice')
      )
    }
  }

  return [...new Set(candidates)]
}

/** 以实际程序名认厂家，不能根据 Word.Application 等别名认定安装了微软软件。 */
export function classifyOfficeRegistration(
  registration: OfficeComRegistration,
  isFile: (filePath: string) => boolean,
  env: NodeJS.ProcessEnv
): OfficeComProgram | null {
  const executable = registrationExecutable(registration, env)

  if (!executable || !path.win32.isAbsolute(executable) || !isFile(executable)) {
    return null
  }

  const name = path.win32.basename(executable).toLowerCase()

  const provider =
    name === MS_EXECUTABLES[registration.kind]
      ? 'ms-office'
      : WPS_EXECUTABLES[registration.kind]?.includes(name)
        ? 'wps'
        : null

  return provider ? { ...registration, executable, provider } : null
}

/** 区分可执行文件和目录，缺失或不可读取的路径不作为可用转换器；PATH 里失效的网络盘最多等 5 秒。 */
function isProgramFile(filePath: string): Promise<boolean> {
  return Promise.race([
    fs.promises.stat(filePath).then(
      stat => stat.isFile(),
      () => false
    ),
    new Promise<boolean>(resolve => setTimeout(resolve, 5000, false).unref())
  ])
}

/** 取出注册表启动命令里的程序路径，展开环境变量；格式不对时返回 undefined。 */
function registrationExecutable(registration: OfficeComRegistration, env: NodeJS.ProcessEnv) {
  const raw = expandWindowsEnvRefs(registration.serverExecutable || registration.command, env).trim()
  const match = raw.match(/^"([^"\r\n]+\.exe)"(?:\s|$)|^([^"\r\n]+?\.exe)(?:\s|$)/i)

  return match?.[1] || match?.[2]
}

/** WPS 专用入口优先，避免同时安装时用微软通用 CLSID 激活错误的应用。 */
function comCandidateRank(program: OfficeComProgram): number {
  return program.provider === 'wps' && /^(Word|PowerPoint|Excel)\.Application(?:\.\d+)?$/i.test(program.progId) ? 1 : 0
}

/** 同进程共享探测；失效后重新读取，旧请求完成不能覆盖新的探测。 */
export function createOfficeDetector(overrides: Partial<OfficeDetectionDeps> = {}) {
  const deps: OfficeDetectionDeps = {
    readComRegistrations: readOfficeComRegistrations,
    isFile: isProgramFile,
    env: process.env,
    ...overrides
  }

  let cached: Promise<OfficeDetection> | undefined

  /** 检查真实路径，并按 MS Office、WPS、LibreOffice 给出每类文件的转换候选。 */
  async function detect(): Promise<{ complete: boolean; result: OfficeDetection }> {
    // 注册表查询失败只影响 MS Office 和 WPS，不能连带丢掉不依赖注册表的 LibreOffice。
    const com = await deps.readComRegistrations().then(
      registrations => ({ registrations }),
      (error: unknown) => ({ error, registrations: [] as OfficeComRegistration[] })
    )

    // 先并行检查所有候选路径，再按结果分类；不逐个同步等待磁盘。
    const candidates = libreOfficeCandidates(process.platform, deps.env, os.homedir())

    const paths = [
      ...new Set([
        ...com.registrations.flatMap(registration => registrationExecutable(registration, deps.env) || []),
        ...candidates
      ])
    ]

    const checked = await Promise.all(paths.map(async file => ((await deps.isFile(file)) ? file : '')))
    const existing = new Set(checked.filter(Boolean))

    const programs = com.registrations
      .map(registration => classifyOfficeRegistration(registration, file => existing.has(file), deps.env))
      .filter(program => program !== null)
      .sort((left, right) => comCandidateRank(left) - comCandidateRank(right))

    const libreOffice = candidates.find(file => existing.has(file))

    // 没有任何可用候选时保留查询异常，调用方才能区分“查询失败”和“确实没装”。
    if ('error' in com && !libreOffice) {
      throw com.error
    }

    const result: OfficeDetection = { word: [], slides: [], sheet: [] }

    for (const kind of Object.keys(result) as OfficeDocumentKind[]) {
      result[kind] = OFFICE_CONVERTER_ORDER.flatMap((provider): OfficeProgram[] => {
        if (provider === 'libreoffice') {
          return libreOffice ? [{ executable: libreOffice, provider: 'libreoffice' as const }] : []
        }

        const seen = new Set<string>()
        const candidates = programs.filter(candidate => candidate.kind === kind && candidate.provider === provider)

        return candidates.filter(candidate => {
          const key = JSON.stringify([
            candidate.executable.toLowerCase(),
            candidate.progId.toLowerCase(),
            candidate.registryView
          ])

          if (seen.has(key)) {
            return false
          }

          seen.add(key)

          return provider === 'wps' || candidate === candidates[0]
        })
      })
    }

    return { complete: !('error' in com), result }
  }

  return {
    /** 复用正在进行或已完成的查询；查询异常或结果不完整时允许下次显式调用重试。 */
    get(): Promise<OfficeDetection> {
      if (!cached) {
        /** 只作废自己这次查询，不清掉其后发起的新查询。 */
        const forget = () => {
          if (cached === pending) {
            cached = undefined
          }
        }

        const pending: Promise<OfficeDetection> = detect().then(
          ({ complete, result }) => {
            if (!complete) {
              forget()
            }

            return result
          },
          error => {
            forget()

            throw error
          }
        )

        cached = pending
      }

      return cached
    },
    /** 转换确认程序不可用时作废缓存；不自动重试或启动软件。 */
    invalidate(): void {
      cached = undefined
    }
  }
}
