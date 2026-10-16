import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { officeCacheKey, OfficePreviewCache } from './cache'
import { OfficePreviewJobs } from './jobs'

let fixture: string
let now: number
const pdf = Buffer.from('%PDF-1.7\nfixture document\n%%EOF\n')

/** 构造版本键，所有文件定位信息只属于本轮临时目录。 */
function keyFor(name: string) {
  return officeCacheKey({ realPath: path.join(fixture, name), size: pdf.length, mtimeMs: now })
}

/** 模拟转换产物，发布后清理源临时目录；只生成测试文件，不启动 Office。 */
async function publishFixture(cache: OfficePreviewCache, key: string, time = now, content = pdf) {
  const work = await cache.createWorkDirectory(time)
  const output = path.join(work, 'converted.pdf')
  await fs.writeFile(output, content)
  await cache.publish(key, output, 'wps', time)
  await cache.discardWorkDirectory(work)
}

beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-office-cache-'))
  now = Date.now()
})
afterEach(async () => {
  const relative = path.relative(os.tmpdir(), fixture)

  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith('hermes-office-cache-')) {
    throw new Error('Unsafe test cleanup directory')
  }

  await fs.rm(fixture, { recursive: true, force: true })
})

describe('Office cache', () => {
  it('changes the version when real path, size or modification time changes', async () => {
    const source = path.join(fixture, '中文报告.docx')
    await fs.writeFile(source, 'fixture source')
    const stat = await fs.stat(source)
    const fingerprint = { realPath: await fs.realpath(source), size: stat.size, mtimeMs: stat.mtimeMs }
    const version = officeCacheKey(fingerprint)
    expect(officeCacheKey({ ...fingerprint })).toBe(version)

    for (const changed of [
      { ...fingerprint, realPath: source + '.other' },
      { ...fingerprint, size: stat.size + 1 },
      { ...fingerprint, mtimeMs: stat.mtimeMs + 1 }
    ]) {
      expect(officeCacheKey(changed)).not.toBe(version)
    }
  })

  it('hides work in progress, publishes PDF and metadata together, and keeps source files out of the cache', async () => {
    const cache = new OfficePreviewCache(path.join(fixture, 'account-A'))
    const key = keyFor('source.docx')
    const work = await cache.createWorkDirectory(now)
    const output = path.join(work, 'converted.pdf')
    await fs.writeFile(output, pdf)
    await fs.writeFile(path.join(work, 'source.docx'), 'private source')
    expect(await cache.get(key, now)).toBeNull()
    await cache.publish(key, output, 'ms-office', now)
    const cached = await cache.get(key, now + 1000)
    expect(cached).toMatchObject({ converter: 'ms-office', convertedAt: now, version: key })
    expect(Buffer.from(cached!.pdf)).toEqual(pdf)
    expect((await fs.readdir(path.join(cache.directory, key))).sort()).toEqual(['doc.pdf', 'note.json'])
    expect(await fs.readFile(path.join(work, 'source.docx'), 'utf8')).toBe('private source')
    expect(await fs.readFile(path.join(cache.directory, key, 'note.json'), 'utf8')).not.toContain(fixture)
    await cache.discardWorkDirectory(work)
    const reopened = new OfficePreviewCache(path.join(fixture, 'account-A'))
    expect(Buffer.from((await reopened.get(key, now + 2000))!.pdf)).toEqual(pdf)
  })

  it('keeps accounts A and B independent even when both preview the same external file', async () => {
    const a = new OfficePreviewCache(path.join(fixture, 'account-A'))
    const b = new OfficePreviewCache(path.join(fixture, 'account-B'))
    const key = keyFor('shared.docx')
    await publishFixture(a, key)
    expect(await b.get(key, now)).toBeNull()
    const other = Buffer.from('%PDF-1.7\naccount B\n%%EOF\n')
    await publishFixture(b, key, now, other)
    expect(Buffer.from((await a.get(key, now))!.pdf)).toEqual(pdf)
    expect(Buffer.from((await b.get(key, now))!.pdf)).toEqual(other)
    await expect(a.discardWorkDirectory(await b.createWorkDirectory(now))).rejects.toThrow('outside managed directory')
  })

  it('refreshes recent use and evicts the least recently used cache when entry count exceeds the limit', async () => {
    const cache = new OfficePreviewCache(fixture, { maxEntries: 2, maxBytes: 1024 * 1024 })
    const [a, b, c] = ['a', 'b', 'c'].map(keyFor)
    await publishFixture(cache, a, now)
    await publishFixture(cache, b, now + 1000)
    await cache.get(a, now + 2000)
    await publishFixture(cache, c, now + 3000)
    expect(await cache.get(b, now + 4000)).toBeNull()
    expect(await cache.get(a, now + 4000)).not.toBeNull()
    expect(await cache.get(c, now + 4000)).not.toBeNull()
  })

  it('evicts by total bytes while always retaining the latest PDF even above the quota', async () => {
    const cache = new OfficePreviewCache(fixture, { maxEntries: 30, maxBytes: pdf.length * 2 })
    const a = keyFor('a')
    const b = keyFor('b')
    await publishFixture(cache, a, now)
    const alreadyReturned = await cache.get(a, now)
    await publishFixture(cache, b, now + 1000)
    expect(await cache.get(a, now + 2000)).toBeNull()
    expect(Buffer.from((await cache.get(b, now + 2000))!.pdf)).toEqual(pdf)
    expect(Buffer.from(alreadyReturned!.pdf)).toEqual(pdf)
  })

  it('cleans only stale owned work at startup and leaves fresh work, unrelated folders and external junction targets untouched', async () => {
    const cache = new OfficePreviewCache(fixture)
    const stale = await cache.createWorkDirectory(now)
    const fresh = await cache.createWorkDirectory(now)
    const unrelated = path.join(cache.directory, 'user-files')
    const outside = path.join(fixture, 'external-sentinel')
    await fs.mkdir(unrelated)
    await fs.writeFile(path.join(unrelated, 'keep.txt'), 'keep')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep')
    await fs.symlink(outside, path.join(stale, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await fs.utimes(stale, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000))
    const reopened = new OfficePreviewCache(fixture)
    await reopened.get(keyFor('none'), now)
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.stat(fresh)).isDirectory()).toBe(true)
    expect(await fs.readFile(path.join(unrelated, 'keep.txt'), 'utf8')).toBe('keep')
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('keeps serving the cache when one stale work directory cannot be removed, and retries a failed preparation', async () => {
    const cache = new OfficePreviewCache(fixture)
    const stale = path.join(cache.directory, 'job-locked')
    await fs.mkdir(stale, { recursive: true })
    const old = new Date(now - 2 * 60 * 60 * 1000)
    await fs.utimes(stale, old, old)

    // 杀毒软件或残留进程占用文件时，删除会失败；这不能让之后的预览全部失败。
    const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' })
    const remove = vi.spyOn(fs, 'rm').mockRejectedValueOnce(busy)
    await publishFixture(cache, keyFor('locked.docx'))
    expect((await cache.get(keyFor('locked.docx')))?.converter).toBe('wps')
    expect(remove).toHaveBeenCalled()
    remove.mockRestore()
    // 占用解除后，下一次淘汰会把它清掉。
    await cache.prune(now)
    expect(await fs.stat(stale).catch(() => null)).toBeNull()

    const other = new OfficePreviewCache(path.join(fixture, 'second'))
    const create = vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(busy)
    await expect(other.get(keyFor('retry.docx'))).rejects.toThrow('resource busy')
    create.mockRestore()
    await expect(other.get(keyFor('retry.docx'))).resolves.toBeNull()
  })

  it('does not follow a cache-directory junction or allow traversal cleanup', async () => {
    const cache = new OfficePreviewCache(fixture)
    const key = keyFor('linked')
    await cache.get(key, now)
    const outside = path.join(fixture, 'other-account')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep')
    await fs.symlink(outside, path.join(cache.directory, key), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await cache.get(key, now)).toBeNull()
    await cache.prune(now)
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    await expect(cache.get('../outside', now)).rejects.toThrow('Invalid Office cache key')
    await expect(cache.discardWorkDirectory(outside)).rejects.toThrow('Invalid Office work directory')
  })

  it('treats corrupt cache metadata as a miss and replaces it only with a complete publication', async () => {
    const cache = new OfficePreviewCache(fixture)
    const key = keyFor('corrupt')
    await publishFixture(cache, key)
    await fs.writeFile(path.join(cache.directory, key, 'note.json'), 'broken JSON')
    expect(await cache.get(key, now)).toBeNull()
    await publishFixture(cache, key, now + 1000)
    expect(Buffer.from((await cache.get(key, now + 2000))!.pdf)).toEqual(pdf)
  })

  it('runs queue and cache together so simultaneous requests perform just one conversion', async () => {
    const cache = new OfficePreviewCache(fixture)
    const jobs = new OfficePreviewJobs<Uint8Array>()
    const key = keyFor('simultaneous')
    let conversions = 0

    /** 执行最小真实缓存链路，转换部分只生成夹具 PDF。 */
    async function convert() {
      const hit = await cache.get(key, now)

      if (hit) {
        return hit.pdf
      }

      conversions++
      await publishFixture(cache, key)

      return (await cache.get(key, now))!.pdf
    }

    const results = await Promise.all(Array.from({ length: 3 }, () => jobs.run(cache.directory, key, convert)))
    expect(conversions).toBe(1)
    expect(results.every(result => Buffer.from(result).equals(pdf))).toBe(true)
  })
})
