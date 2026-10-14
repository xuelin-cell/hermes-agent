import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  OFFICE_CONVERTER_ORDER,
  OFFICE_EXTENSIONS,
  officeDocumentKind,
  type OfficeDocumentKind
} from '../../../shared/src/office-preview'

import {
  classifyOfficeRegistration,
  createOfficeDetector,
  libreOfficeCandidates,
  type OfficeComRegistration,
  readOfficeComRegistrations
} from './detect'

/** 构造查询结果；别名和程序路径分别指定，以覆盖被 WPS 接管的微软别名。 */
function registration(
  kind: OfficeDocumentKind,
  executable: string,
  progId = 'Word.Application',
  registryView: '32' | '64' = '64'
): OfficeComRegistration {
  return { kind, progId, registryView, command: `"${executable}" /Automation` }
}

/** 只把测试指定的路径当成真实文件，不修改平台、注册表或本机软件。 */
function detectorFor(registrations: OfficeComRegistration[], files: string[]) {
  return createOfficeDetector({
    readComRegistrations: vi.fn(async () => registrations),
    isFile: file => files.includes(file),
    env: {}
  })
}

describe('Office preview contract', () => {
  it('recognizes all registered extensions across case and path styles, and rejects unrelated files', () => {
    for (const [kind, extensions] of Object.entries(OFFICE_EXTENSIONS)) {
      for (const extension of extensions) {
        expect(officeDocumentKind(`C:\\资料.v1\\报告.${extension.toUpperCase()}`)).toBe(kind)
        expect(officeDocumentKind(`/home/user/报告.${extension}`)).toBe(kind)
      }
    }

    for (const file of ['report.pdf', 'data.csv', 'file.constructor', '/folder.docx/file', 'no-extension']) {
      expect(officeDocumentKind(file)).toBeNull()
    }
  })
})

describe('Office program detection', () => {
  it('classifies by the actual program, not a Microsoft-looking ProgID, retaining the registry view', () => {
    const executable = 'D:\\非默认目录\\WPS Office\\wps.exe'
    const entry = registration('word', executable, 'Word.Application', '32')
    expect(classifyOfficeRegistration(entry, file => file === executable, {})).toEqual({
      ...entry,
      executable,
      provider: 'wps'
    })
  })

  it('honors ServerExecutable, expands environment paths and accepts unquoted registered command lines', () => {
    const actual = 'C:\\Program Files\\Microsoft Office\\WINWORD.EXE'

    const entry = {
      ...registration('word', 'D:\\Other\\wps.exe'),
      serverExecutable: '%ProgramFiles%\\Microsoft Office\\WINWORD.EXE'
    }

    expect(
      classifyOfficeRegistration(entry, file => file === actual, { ProgramFiles: 'C:\\Program Files' })?.provider
    ).toBe('ms-office')
    expect(
      classifyOfficeRegistration(
        { ...entry, serverExecutable: '', command: actual + ' /Automation' },
        file => file === actual,
        {}
      )?.executable
    ).toBe(actual)
    expect(
      classifyOfficeRegistration(
        { ...entry, serverExecutable: 'D:\\Missing\\winword.exe' },
        file => file === actual,
        {}
      )
    ).toBeNull()
  })

  it('rejects missing files, wrong component programs and unknown launchers', () => {
    expect(classifyOfficeRegistration(registration('word', 'C:\\Office\\winword.exe'), () => false, {})).toBeNull()
    expect(classifyOfficeRegistration(registration('slides', 'C:\\Office\\winword.exe'), () => true, {})).toBeNull()
    expect(classifyOfficeRegistration(registration('word', 'C:\\Tools\\other.exe'), () => true, {})).toBeNull()
    expect(
      classifyOfficeRegistration({ ...registration('word', ''), command: 'winword.exe /Automation' }, () => true, {})
    ).toBeNull()
  })

  it('detects WPS alone even when it occupies all Microsoft aliases', async () => {
    const entries = [
      registration('word', 'D:\\wps\\wps.exe'),
      registration('slides', 'D:\\wps\\wpp.exe', 'PowerPoint.Application'),
      registration('sheet', 'D:\\wps\\et.exe', 'Excel.Application')
    ]

    const result = await detectorFor(
      entries,
      entries.map(entry => entry.command.split('"')[1])
    ).get()

    expect(Object.values(result).map(programs => programs.map(program => program.provider))).toEqual([
      ['wps'],
      ['wps'],
      ['wps']
    ])
  })

  it('detects a partial Office installation without claiming absent components', async () => {
    const executable = 'C:\\Office\\WINWORD.EXE'
    const result = await detectorFor([registration('word', executable)], [executable]).get()
    expect(result.word[0].provider).toBe('ms-office')
    expect(result.slides).toEqual([])
    expect(result.sheet).toEqual([])
    expect(await detectorFor([], []).get()).toEqual({ word: [], slides: [], sheet: [] })
  })

  it('orders available providers and deduplicates COM aliases and registry views', async () => {
    const word = 'C:\\Office\\winword.exe'
    const wps = 'D:\\WPS\\wps.exe'
    const libreOffice = libreOfficeCandidates(process.platform, {}, '')[0]

    const entries = [
      registration('word', wps, 'KWPS.Application'),
      registration('word', word),
      registration('word', word, 'Word.Application', '32'),
      registration('word', wps)
    ]

    const result = await detectorFor(entries, [word, wps, libreOffice]).get()
    expect(result.word.map(program => program.provider)).toEqual(OFFICE_CONVERTER_ORDER)
    expect(result.slides.map(program => program.provider)).toEqual(['libreoffice'])
    expect(result.sheet.map(program => program.provider)).toEqual(['libreoffice'])
  })

  it('prefers WPS-specific ProgIDs over occupied Microsoft aliases regardless of registry result order', async () => {
    const entries = [
      registration('word', 'D:\\WPS\\wps.exe', 'Word.Application', '32'),
      registration('word', 'D:\\WPS\\wps.exe', 'KWPS.Application', '32'),
      registration('slides', 'D:\\WPS\\wpp.exe', 'PowerPoint.Application', '32'),
      registration('slides', 'D:\\WPS\\wps.exe', 'KWPP.Application', '32'),
      registration('sheet', 'D:\\WPS\\et.exe', 'Excel.Application', '32'),
      registration('sheet', 'D:\\WPS\\wps.exe', 'KET.Application', '32')
    ]

    const result = await detectorFor(entries, ['D:\\WPS\\wps.exe', 'D:\\WPS\\wpp.exe', 'D:\\WPS\\et.exe']).get()
    expect(Object.values(result).map(programs => programs[0].provider)).toEqual(['wps', 'wps', 'wps'])
    expect(Object.values(result).map(programs => 'progId' in programs[0] && programs[0].progId)).toEqual([
      'KWPS.Application', 'KWPP.Application', 'KET.Application'
    ])
  })

  it('shares concurrent probes until invalidated, then refreshes changed installations', async () => {
    const readComRegistrations = vi.fn(async () => [] as OfficeComRegistration[])
    const detector = createOfficeDetector({ readComRegistrations, isFile: () => false, env: {} })
    const first = detector.get()
    expect(detector.get()).toBe(first)
    await first
    await detector.get()
    expect(readComRegistrations).toHaveBeenCalledTimes(1)
    detector.invalidate()
    await detector.get()
    expect(readComRegistrations).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed query as an empty installation', async () => {
    const readComRegistrations = vi.fn().mockRejectedValueOnce(new Error('query timeout')).mockResolvedValue([])
    const detector = createOfficeDetector({ readComRegistrations, isFile: () => false, env: {} })
    await expect(detector.get()).rejects.toThrow('query timeout')
    await expect(detector.get()).resolves.toEqual({ word: [], slides: [], sheet: [] })
    expect(readComRegistrations).toHaveBeenCalledTimes(2)
  })

  it('keeps LibreOffice usable when the registry query fails, then recovers the COM programs', async () => {
    const winword = 'C:\\Office\\winword.exe'

    const readComRegistrations = vi
      .fn()
      .mockRejectedValueOnce(new Error('powershell blocked'))
      .mockResolvedValue([registration('word', winword)])

    const detector = createOfficeDetector({
      readComRegistrations,
      isFile: file => file === winword || /soffice(\.exe)?$/.test(file),
      env: {}
    })

    const degraded = await detector.get()

    for (const programs of Object.values(degraded)) {
      expect(programs.map(program => program.provider)).toEqual(['libreoffice'])
    }

    expect((await detector.get()).word.map(program => program.provider)).toEqual(['ms-office', 'libreoffice'])
    await detector.get()
    expect(readComRegistrations).toHaveBeenCalledTimes(2)
  })

  it('keeps the fresh probe cached when an invalidated older query fails late', async () => {
    let failOld!: (error: Error) => void

    const readComRegistrations = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failOld = reject
          })
      )
      .mockResolvedValue([])

    const detector = createOfficeDetector({ readComRegistrations, isFile: () => false, env: {} })
    const old = detector.get()
    const rejection = expect(old).rejects.toThrow('old error')
    detector.invalidate()
    const fresh = detector.get()
    await fresh
    failOld(new Error('old error'))
    await rejection
    expect(detector.get()).toBe(fresh)
  })

  it.runIf(process.platform === 'win32')('reads the real Windows registry without activating Office', async () => {
    const registrations = await readOfficeComRegistrations()

    for (const entry of registrations) {
      expect(Object.keys(OFFICE_EXTENSIONS)).toContain(entry.kind)
      expect(['32', '64']).toContain(entry.registryView)

      const program = classifyOfficeRegistration(
        entry,
        file => {
          try {
            return fs.statSync(file).isFile()
          } catch {
            return false
          }
        },
        process.env
      )

      if (program) {
        expect(path.win32.isAbsolute(program.executable)).toBe(true)
      }
    }
  })
})

describe('LibreOffice candidates', () => {
  it('checks absolute PATH entries first, preserves spaces, excludes current-directory search and deduplicates', () => {
    const paths = libreOfficeCandidates(
      'win32',
      {
        Path: ';"D:\\My Office";relative;D:\\My Office',
        ProgramFiles: 'X:\\Apps',
        ProgramW6432: 'X:\\Apps',
        LOCALAPPDATA: 'C:\\Local'
      },
      ''
    )

    expect(paths[0]).toBe('D:\\My Office\\soffice.exe')
    expect(paths).toContain('X:\\Apps\\LibreOffice\\program\\soffice.exe')
    expect(paths).toContain('C:\\Local\\Programs\\LibreOffice\\program\\soffice.exe')
    expect(paths.some(candidate => candidate.startsWith('relative') || candidate === 'soffice.exe')).toBe(false)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('generates Linux and macOS paths as pure data, without pretending to run on another OS', () => {
    expect(libreOfficeCandidates('linux', { PATH: '/custom/bin:/usr/bin' }, '/users/test')[0]).toBe(
      '/custom/bin/soffice'
    )
    expect(libreOfficeCandidates('darwin', {}, '/users/test')).toContain(
      '/Applications/LibreOffice.app/Contents/MacOS/soffice'
    )
    expect(libreOfficeCandidates('darwin', {}, '/users/test')).toContain(
      '/users/test/Applications/LibreOffice.app/Contents/MacOS/soffice'
    )
  })
})
