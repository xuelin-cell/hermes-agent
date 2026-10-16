import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { CloudDriveClient } from './cloud-drive'
import { createDriveArtifactResolver } from './cloud-drive-artifact-source'
import { CloudDriveTransfers } from './cloud-drive-transfers'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hermes-drive-artifact-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 真实本机文件与明确 Profile 的会话响应，便于核对来源和分片前的文件快照。 */
async function fixture() {
  const file = path.join(root, 'report.txt')
  await writeFile(file, 'artifact bytes')
  const connect = vi.fn(async () => ({ mode: 'local' }))

  const read = vi.fn<(backend: unknown, route: string, signal: AbortSignal) => Promise<unknown>>(
    async (_backend, route) =>
      route.includes('/messages?')
        ? { profile: 'work', messages: [{ role: 'assistant', content: `MEDIA:${file}` }] }
        : { id: 'session-one', profile: 'work', cwd: root }
  )

  const resolve = createDriveArtifactResolver({ workspace: root, connect, read })
  const source = { sessionId: 'session-one', profile: 'work', connectionId: 'local', value: file }

  return { file, connect, read, resolve, source }
}

it('主进程核对会话记录后返回固定文件快照，所有请求绑定原 Profile', async () => {
  const fixtureData = await fixture()
  const result = await fixtureData.resolve(fixtureData.source, new AbortController().signal)
  expect(result.path).toBe(await realpath(fixtureData.file))
  expect(result.snapshot).toMatchObject({ size: 14, ino: (await stat(fixtureData.file)).ino })
  expect(fixtureData.connect).toHaveBeenCalledWith('work')
  expect(
    fixtureData.read.mock.calls.every(
      ([, route]) => new URL(route, 'http://fixture').searchParams.get('profile') === 'work'
    )
  ).toBe(true)
})

it('拒绝远程来源和用户消息里的伪造产物，也不能用路径前缀冒领其他文件', async () => {
  const data = await fixture()
  const signal = new AbortController().signal
  await expect(data.resolve({ ...data.source, connectionId: 'ssh-remote' }, signal)).rejects.toMatchObject({
    result: { code: 'ARTIFACT_SOURCE_INVALID' }
  })
  data.connect.mockResolvedValueOnce({ mode: 'remote' })
  await expect(data.resolve(data.source, signal)).rejects.toMatchObject({ result: { code: 'ARTIFACT_SOURCE_REMOTE' } })
  expect(data.read).not.toHaveBeenCalled()
  data.read.mockImplementation(async (_backend, route) =>
    route.includes('/messages?')
      ? {
          profile: 'work',
          messages: [
            { role: 'user', content: data.file },
            { role: 'assistant', content: data.file + '.secret' }
          ]
        }
      : { id: 'session-one', profile: 'work', cwd: root }
  )
  await expect(data.resolve(data.source, signal)).rejects.toMatchObject({ result: { code: 'ARTIFACT_NOT_REFERENCED' } })
})

it('复用敏感文件规则，符号链接到凭据也不能上传', async () => {
  const data = await fixture()
  const sensitive = path.join(root, '.env')
  const alias = path.join(root, 'alias.txt')
  await writeFile(sensitive, 'PRIVATE_KEY=never-upload')
  await symlink(sensitive, alias)
  await expect(data.resolve({ ...data.source, value: sensitive }, new AbortController().signal)).rejects.toMatchObject({
    result: { code: 'ARTIFACT_SOURCE_BLOCKED' }
  })
  await expect(data.resolve({ ...data.source, value: alias }, new AbortController().signal)).rejects.toMatchObject({
    result: { code: 'ARTIFACT_SOURCE_BLOCKED' }
  })
  expect(data.read.mock.calls.some(([, route]) => route.includes('/messages?'))).toBe(false)
})

it('会话响应的身份不匹配时终止核对，不借用另一个会话的产物记录', async () => {
  const data = await fixture()

  for (const detail of [
    { id: 'another-session', profile: 'work', cwd: root },
    { id: 'session-one', profile: 'another-profile', cwd: root }
  ]) {
    data.read.mockResolvedValueOnce(detail)
    await expect(data.resolve(data.source, new AbortController().signal)).rejects.toMatchObject({
      result: { code: 'ARTIFACT_SOURCE_INVALID' }
    })
  }

  expect(data.read.mock.calls.some(([, route]) => route.includes('/messages?'))).toBe(false)
})

it('相对产物路径按所属会话 cwd 解析，分页中的旧产物仍可核对', async () => {
  const data = await fixture()
  data.read.mockImplementation(async (_backend, route) => {
    if (!route.includes('/messages?')) {
      return { id: 'session-one', profile: 'work', cwd: root }
    }

    const offset = Number(new URL(route, 'http://fixture').searchParams.get('offset'))

    return {
      profile: 'work',
      messages:
        offset === 0
          ? Array.from({ length: 2 }, () => ({ role: 'assistant', content: 'earlier notes' }))
          : [{ role: 'tool', content: JSON.stringify({ output_path: './report.txt' }) }],
      pagination: { offset, limit: 2 }
    }
  })
  const result = await data.resolve({ ...data.source, value: './report.txt' }, new AbortController().signal)
  expect(await readFile(result.path, 'utf8')).toBe('artifact bytes')
  expect(data.read.mock.calls.filter(([, route]) => route.includes('/messages?'))).toHaveLength(2)
})

it('取消正在核对的请求立即结束，迟到响应不继续扫描', async () => {
  const data = await fixture()
  const controller = new AbortController()
  let finish!: (value: unknown) => void
  data.read.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const pending = data.resolve(data.source, controller.signal)
  await vi.waitFor(() => expect(finish).toBeDefined())
  controller.abort()
  await expect(pending).rejects.toThrow()
  finish({ id: 'session-one', profile: 'work', cwd: root })
  await Promise.resolve()
  expect(data.read).toHaveBeenCalledTimes(1)
})

it('核对后被替换的本机文件在打开时失败，云盘没有收到任何上传分片', async () => {
  const data = await fixture()
  const authorized = await data.resolve(data.source, new AbortController().signal)
  await writeFile(data.file, 'changed after authorization')
  const request = vi.fn<typeof fetch>()

  const identity = {
    uid: 'user',
    token: 'private-login',
    phone: '13800000000',
    maskedPhone: '138****0000',
    expiresAt: Date.now() + 60_000
  }

  const transfers = new CloudDriveTransfers(new CloudDriveClient(() => identity, request), path.join(root, 'cache'))

  const result = await transfers.run(
    1,
    { id: 'artifact-upload', operation: 'upload', parentAssetId: 'root' },
    { selectUpload: async () => authorized, selectDownload: async () => null, progress: () => {} }
  )

  expect(result).toMatchObject({ status: 'failed', code: 'FILE_CHANGED' })
  expect(request).not.toHaveBeenCalled()
})

it('两个账号工作区 A→B→A 核对时不复用别的账号路径和文件快照', async () => {
  const contents: string[] = []
  const roots = [path.join(root, 'home-a'), path.join(root, 'home-b')]

  for (const [index, directory] of roots.entries()) {
    await mkdir(directory)
    await writeFile(path.join(directory, 'report.txt'), index === 0 ? 'account-a' : 'account-b')
  }

  for (const directory of [roots[0], roots[1], roots[0]]) {
    const resolver = createDriveArtifactResolver({
      workspace: directory,
      connect: async () => ({ mode: 'local' }),
      read: async (_backend, route) =>
        route.includes('/messages?')
          ? { profile: 'default', messages: [{ role: 'assistant', content: 'MEDIA:./report.txt' }] }
          : { id: 'session-one', profile: 'default', cwd: directory }
    })

    const selected = await resolver(
      { sessionId: 'session-one', profile: 'default', value: './report.txt' },
      new AbortController().signal
    )

    contents.push(await readFile(selected.path, 'utf8'))
  }

  expect(contents).toEqual(['account-a', 'account-b', 'account-a'])
})
