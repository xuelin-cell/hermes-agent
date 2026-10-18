import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { OFFICE_PDF_MAX_BYTES, OFFICE_SOURCE_MAX_BYTES, OFFICE_TIMEOUT_MS } from '../../../shared/src/office-preview'

import { OfficePreviewCache } from './cache'
import type { convertCom } from './convert-com'
import type { convertLibreOffice } from './convert-libreoffice'
import type { OfficeComProgram } from './detect'
import { createOfficePreviewService } from './service'

let root: string
let source: string
const pdf = Buffer.from('%PDF-1.7\ncontrolled conversion\n%%EOF')

const ms: OfficeComProgram = {
  kind: 'word',
  provider: 'ms-office',
  executable: process.execPath,
  progId: 'Word.Application',
  registryView: '64',
  command: ''
}

const wps: OfficeComProgram = { ...ms, provider: 'wps', progId: 'KWPS.Application' }
const lo = { provider: 'libreoffice' as const, executable: process.execPath }

/** 测试用正式文件、账号缓存和队列，只替换实际软件转换器。 */
function setup(account = 'A') {
  const detector = { get: vi.fn(async () => ({ word: [lo, wps, ms], slides: [], sheet: [] })), invalidate: vi.fn() }

  const com = vi.fn<typeof convertCom>().mockImplementation(async (_program, copy, directory) => {
    expect(path.basename(copy)).toBe('source.docx')
    expect(await fs.readFile(copy, 'utf8')).toBe('source text')
    const pdfPath = path.join(directory, 'result.pdf')
    await fs.writeFile(pdfPath, pdf)

    return { ok: true, pdfPath }
  })

  const libreoffice = vi
    .fn<typeof convertLibreOffice>()
    .mockResolvedValue({ ok: false, code: 'unavailable', cleanupSafe: true })

  const state = path.join(root, account)

  return {
    state,
    detector,
    com,
    libreoffice,
    service: createOfficePreviewService(state, { detector, com, libreoffice })
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-office-service-'))
  source = path.join(root, "中文 '样例'.docx")
  await fs.writeFile(source, 'source text')
})
afterEach(async () => {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('hermes-office-service-')) {
    throw new Error('Unsafe cleanup')
  }

  await fs.rm(root, { recursive: true, force: true })
})

it('按厂家顺序安全降级，合并并发并命中缓存，A→B→A 不共用账号缓存', async () => {
  const a = setup()
  a.com.mockResolvedValueOnce({ ok: false, code: 'convert_failed', cleanupSafe: true })
  const [first, duplicate] = await Promise.all([a.service.convert(source), a.service.convert(source)])
  expect(first).toEqual(duplicate)
  expect(first).toMatchObject({ ok: true, converter: 'wps', pdf })
  expect(a.com.mock.calls.map(call => call[0].provider)).toEqual(['ms-office', 'wps'])
  expect(a.libreoffice).not.toHaveBeenCalled()
  expect(await a.service.convert(source)).toEqual(first)
  expect(a.com).toHaveBeenCalledTimes(2)
  const b = setup('B')
  expect(await b.service.convert(source)).toMatchObject({ ok: true, converter: 'ms-office' })
  expect(b.com).toHaveBeenCalledTimes(1)
  expect(await a.service.convert(source)).toEqual(first)
  expect(a.com).toHaveBeenCalledTimes(2)
  expect(await fs.readFile(source, 'utf8')).toBe('source text')
  expect((await fs.readdir(path.join(a.state, 'office-preview'))).every(name => /^[a-f0-9]{64}$/.test(name))).toBe(true)
  await fs.writeFile(source, 'source text changed')
  a.com.mockResolvedValue({ ok: false, code: 'unavailable', cleanupSafe: true })
  expect(await a.service.convert(source)).toEqual({ ok: false, code: 'unavailable' })
  expect(a.com).toHaveBeenCalledTimes(4)
  expect(a.detector.invalidate).toHaveBeenCalled()
})

it('后台预转换复用原缓存，已缓存文件不等待别的文件转换', async () => {
  const fixture = setup()
  const warmed = await fixture.service.convert(source, undefined, true)
  expect(warmed).toMatchObject({ ok: true, pdf })
  const other = path.join(root, 'blocking.docx')
  await fs.writeFile(other, 'source text')
  let release!: () => void
  let begun!: () => void

  const started = new Promise<void>(resolve => {
    begun = resolve
  })

  const gate = new Promise<void>(resolve => {
    release = resolve
  })

  fixture.com.mockImplementationOnce(async () => {
    begun()
    await gate

    return { ok: false, code: 'unavailable', cleanupSafe: true }
  })
  const pending = fixture.service.convert(other, undefined, true)
  await started
  let reused = false

  const foreground = fixture.service.convert(source).then(result => {
    expect(result).toEqual(warmed)
    reused = true
  })

  try {
    await vi.waitFor(() => expect(reused).toBe(true), { timeout: 2000 })
  } finally {
    release()
    await Promise.all([pending, foreground])
  }
})

it('后台只准备十分钟内的新文件，旧文件有缓存仍复用，主动打开不受时间限制', async () => {
  const fixture = setup()
  const old = new Date(Date.now() - 11 * 60_000)
  await fs.utimes(source, old, old)
  expect(await fixture.service.convert(source, undefined, true)).toEqual({ ok: false, code: 'unavailable' })
  expect(fixture.com).not.toHaveBeenCalled()
  expect(fixture.detector.get).not.toHaveBeenCalled()
  const opened = await fixture.service.convert(source)
  expect(opened).toMatchObject({ ok: true, pdf })
  expect(await fixture.service.convert(source, undefined, true)).toEqual(opened)
  expect(fixture.com).toHaveBeenCalledTimes(1)
  const recent = new Date()
  await fs.utimes(source, recent, recent)
  expect(await fixture.service.convert(source, undefined, true)).toMatchObject({ ok: true, pdf })
  expect(fixture.com).toHaveBeenCalledTimes(2)
})

it('WPS 的第一个入口安全失败后尝试同厂家备用入口，收尾不安全则立即停止', async () => {
  const fixture = setup()
  const second = { ...wps, progId: 'WPS.Application' }
  fixture.detector.get.mockResolvedValue({ word: [wps, second, lo], slides: [], sheet: [] })
  fixture.com.mockResolvedValueOnce({ ok: false, code: 'unavailable', cleanupSafe: true })
  expect(await fixture.service.convert(source)).toMatchObject({ ok: true, converter: 'wps' })
  expect(fixture.com.mock.calls.map(call => call[0].progId)).toEqual(['KWPS.Application', 'WPS.Application'])
  expect(new Set(fixture.com.mock.calls.map(call => call[2])).size).toBe(2)
  expect(fixture.libreoffice).not.toHaveBeenCalled()
  const blocked = setup('blocked')
  blocked.detector.get.mockResolvedValue({ word: [wps, second, lo], slides: [], sheet: [] })
  blocked.com.mockResolvedValueOnce({ ok: false, code: 'timeout', cleanupSafe: false })
  expect(await blocked.service.convert(source)).toEqual({ ok: false, code: 'timeout' })
  expect(blocked.com).toHaveBeenCalledTimes(1)
  expect(blocked.libreoffice).not.toHaveBeenCalled()
})

it('排队期间文件被再次保存时转换保存后的版本，而不是报告失败', async () => {
  const a = setup()
  const other = path.join(root, 'other.docx')
  await fs.writeFile(other, 'source text')
  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))

  a.com.mockImplementationOnce(async (_program, _copy, directory) => {
    await gate
    const pdfPath = path.join(directory, 'result.pdf')
    await fs.writeFile(pdfPath, pdf)

    return { ok: true, pdfPath }
  })

  // 先让另一份文件占住队列，再提交被测文件，保证它确实在排队。
  const first = a.service.convert(other)
  await vi.waitFor(() => expect(a.com).toHaveBeenCalledTimes(1))
  const queued = a.service.convert(source)
  await new Promise(resolve => setTimeout(resolve, 200))
  const saved = new Date(Date.now() + 60_000)
  await fs.utimes(source, saved, saved)
  release()

  expect(await first).toMatchObject({ ok: true })
  const result = await queued
  expect(result).toMatchObject({ ok: true, converter: 'ms-office', pdf })
  // 结果按保存后的版本缓存：再次打开直接命中，不再转换。
  expect(await a.service.convert(source)).toEqual(result)
  expect(a.com).toHaveBeenCalledTimes(2)
})

it('转换成功后删除临时目录失败，仍返回已经发布的结果', async () => {
  const a = setup()
  const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' })
  const discard = vi.spyOn(OfficePreviewCache.prototype, 'discardWorkDirectory').mockRejectedValueOnce(busy)
  expect(await a.service.convert(source)).toMatchObject({ ok: true, converter: 'ms-office', pdf })
  expect(discard).toHaveBeenCalledTimes(1)
  discard.mockRestore()
})

it('收尾不确定停止降级，保留目录，超过一小时或服务重建也不回收证据', async () => {
  const fixture = setup()
  fixture.com.mockResolvedValue({ ok: false, code: 'timeout', cleanupSafe: false })
  expect(await fixture.service.convert(source)).toEqual({ ok: false, code: 'timeout' })
  expect(fixture.com).toHaveBeenCalledTimes(1)
  expect(fixture.libreoffice).not.toHaveBeenCalled()
  const cache = new OfficePreviewCache(fixture.state)
  const [name] = await fs.readdir(cache.directory)
  const retained = path.join(cache.directory, name)
  expect(await fs.readFile(path.join(retained, 'retain'), 'utf8')).toBe('cleanup-unconfirmed')
  await fs.utimes(retained, new Date(0), new Date(0))
  await cache.prune(Date.now() + 2 * 60 * 60 * 1000)
  expect(await fs.readFile(path.join(retained, 'source.docx'), 'utf8')).toBe('source text')
})

it('三家顺序降级共用剩余预算，LibreOffice 成功后按同一约定发布缓存', async () => {
  const fixture = setup()
  let now = 0
  fixture.com.mockImplementation(async () => {
    now += 60_000

    return { ok: false, code: 'convert_failed', cleanupSafe: true }
  })
  fixture.libreoffice.mockImplementation(async (_program, _copy, directory) => {
    const pdfPath = path.join(directory, 'result.pdf')
    await fs.writeFile(pdfPath, pdf)

    return { ok: true, pdfPath }
  })
  const service = createOfficePreviewService(fixture.state, { ...fixture, now: () => now })
  expect(await service.convert(source)).toMatchObject({ ok: true, converter: 'libreoffice', pdf })
  expect(fixture.com.mock.calls.map(call => call[0].provider)).toEqual(['ms-office', 'wps'])
  expect(fixture.com.mock.calls.map(call => call[3])).toEqual([180_000, 120_000])
  expect(fixture.libreoffice.mock.calls[0][3]).toBe(60_000)
})

it('源文件、产物和类型有上限，伪 PDF 不发布；无软件或全部失败只返回有限原因', async () => {
  const fixture = setup()
  expect(await fixture.service.convert(source + '.txt')).toEqual({ ok: false, code: 'unsupported' })
  expect(await fixture.service.convert(source + '.docx')).toEqual({ ok: false, code: 'not_found' })
  await fs.truncate(source, OFFICE_SOURCE_MAX_BYTES + 1)
  expect(await fixture.service.convert(source)).toEqual({ ok: false, code: 'too_large' })
  expect(fixture.com).not.toHaveBeenCalled()
  await fs.writeFile(source, 'source text')
  fixture.com.mockImplementation(async (_program, _copy, directory) => ({
    ok: true,
    pdfPath: path.join(directory, 'missing.pdf')
  }))
  expect(await fixture.service.convert(source)).toEqual({ ok: false, code: 'convert_failed' })
  fixture.com.mockImplementation(async (_program, _copy, directory) => {
    const pdfPath = path.join(directory, 'bad.pdf')
    await fs.writeFile(pdfPath, 'not PDF')

    return { ok: true, pdfPath }
  })
  expect(await fixture.service.convert(source)).toEqual({ ok: false, code: 'convert_failed' })
  fixture.com.mockImplementation(async (_program, _copy, directory) => {
    const pdfPath = path.join(directory, 'big.pdf')
    await fs.writeFile(pdfPath, pdf)
    await fs.truncate(pdfPath, OFFICE_PDF_MAX_BYTES + 1)

    return { ok: true, pdfPath }
  })
  expect(await fixture.service.convert(source)).toEqual({ ok: false, code: 'too_large' })
  fixture.detector.get.mockResolvedValue({ word: [], slides: [], sheet: [] })
  expect(await fixture.service.convert(source)).toEqual({ ok: false, code: 'unavailable' })
  expect(await fs.readdir(path.join(fixture.state, 'office-preview'))).toEqual([])
})

it('多文件共享串行队列与总预算，账号撤销后不启动等待中的转换', async () => {
  const fixture = setup()
  let now = 0
  let active = true
  let release!: () => void
  let started!: () => void

  const begun = new Promise<void>(resolve => {
    started = resolve
  })

  const wait = new Promise<void>(resolve => {
    release = resolve
  })

  fixture.com.mockImplementation(async () => {
    started()
    await wait
    now += OFFICE_TIMEOUT_MS

    return { ok: false, code: 'timeout', cleanupSafe: true }
  })
  const service = createOfficePreviewService(fixture.state, { ...fixture, now: () => now, active: () => active })
  const first = service.convert(source)
  await begun
  const secondSource = path.join(root, 'second.docx')
  await fs.writeFile(secondSource, 'source text')
  const second = service.convert(secondSource)
  active = false
  release()
  expect(await first).toEqual({ ok: false, code: 'unavailable' })
  expect(await second).toEqual({ ok: false, code: 'unavailable' })
  expect(fixture.com).toHaveBeenCalledTimes(1)
  expect(fixture.libreoffice).not.toHaveBeenCalled()
  active = true
  const budget = service.convert(source)
  expect(await budget).toEqual({ ok: false, code: 'timeout' })
  expect(fixture.com).toHaveBeenCalledTimes(2)
})
