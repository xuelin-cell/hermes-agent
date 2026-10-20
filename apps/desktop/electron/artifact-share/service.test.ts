import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test, vi } from 'vitest'

import { composeArtifactHtml } from '../../../shared/src/artifact-share'

import { startArtifactShareCleanup } from './expiry-cleanup'
import { ArtifactShareService, type ShareIdentity } from './service'

/** 模拟插件对完成的模型回复登记来源，生命周期测试仍经过真实来源校验。 */
function trustedInput(service: ArtifactShareService, home: string, key: string, content: string) {
  service.recordOrigin({ sessionId: 'session-test', profileHome: home, type: 'context', fresh: true })
  service.recordOrigin({ sessionId: 'session-test', profileHome: home, type: 'inline', contents: [content] })

  return { key, title: '报告', html: composeArtifactHtml(content), source: { sessionId: 'session-test', content } }
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

test('发布和撤销共用持久记录，失败撤销保留链接', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-share-'))
  roots.push(root)
  const identity: ShareIdentity = { accountId: 'A', home: path.join(root, 'A'), token: 'secret' }
  const calls: string[] = []
  let deleteFails = true

  const request = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${url}`)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret')

    if (init?.method === 'DELETE') {return new Response(null, { status: deleteFails ? 503 : 204 })}
    const shareId = String(url).match(/\/([^/]+)\.html$/)?.[1]

    return Response.json({ shareId, url: `https://share.example/${shareId}.html` })
  }

  const service = new ArtifactShareService({ identity: () => identity, request: request as typeof fetch })
  await fs.mkdir(identity.home, { recursive: true })
  const input = trustedInput(service, identity.home, 'session:artifact', '<h1>报告</h1>')
  const first = await service.publish(input)
  assert.equal(first.version, 1)
  assert.deepEqual(await service.inspect(input.key), first)
  assert.equal((await service.publish(input)).shareId, first.shareId)
  assert.equal(calls.length, 1)
  const updated = await service.publish(trustedInput(service, identity.home, input.key, '<h1>新版</h1>'))
  assert.equal(updated.shareId, first.shareId)
  assert.equal(updated.version, 2)
  await assert.rejects(service.revoke(input.key), /503/)
  assert.deepEqual(await service.inspect(input.key), updated)
  deleteFails = false
  await service.revoke(input.key)
  assert.equal(await service.inspect(input.key), null)
})

test('账号隔离与同产物串行更新', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-share-'))
  roots.push(root)
  let identity: ShareIdentity = { accountId: 'A', home: path.join(root, 'A'), token: 'A-token' }

  const request = async (url: string | URL | Request) => {
    await new Promise(resolve => setTimeout(resolve, 5))
    const shareId = String(url).match(/\/([^/]+)\.html$/)?.[1]

    return Response.json({ shareId, url: `https://share.example/${shareId}.html` })
  }

  const service = new ArtifactShareService({ identity: () => identity, request: request as typeof fetch })
  await fs.mkdir(identity.home, { recursive: true })
  const input = trustedInput(service, identity.home, 'same-key', '<p>one</p>')
  const updatedInput = trustedInput(service, identity.home, 'same-key', '<p>two</p>')

  const [first, second] = await Promise.all([
    service.publish(input), service.publish(updatedInput)
  ])

  assert.equal(second.version, 2)
  assert.equal(second.shareId, first.shareId)
  identity = { accountId: 'B', home: path.join(root, 'B'), token: 'B-token' }
  assert.equal(await service.inspect(input.key), null)
})

test('首次发布结果不明时重试复用原分享 ID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-share-'))
  roots.push(root)
  const ids: string[] = []

  const request = async (url: string | URL | Request) => {
    const id = String(url).match(/\/([^/]+)\.html$/)?.[1] ?? ''
    ids.push(id)

    if (ids.length === 1) {throw new Error('response lost')}

    return Response.json({ shareId: id, url: `https://share.example/${id}.html` })
  }

  const identity = () => ({ accountId: 'A', home: root, token: 'secret' })
  const initial = new ArtifactShareService({ identity, request: request as typeof fetch })
  const input = trustedInput(initial, root, 'session:file', '<p>ready</p>')
  await assert.rejects(initial.publish(input), /response lost/)
  const recovered = await new ArtifactShareService({ identity, request: request as typeof fetch }).publish(input)
  assert.equal(recovered.shareId, ids[0])
  assert.deepEqual(ids, [ids[0], ids[0]])
})

test('历史工具结果按分享 ID 查询，账号往返隔离且旧卡片不能撤销新链接', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-share-id-'))
  roots.push(root)
  const ownerA = { accountId: 'A', home: path.join(root, 'A'), token: 'token-A' }
  let identity: ShareIdentity = ownerA
  const deleted: string[] = []
  const request = async (url: string | URL | Request, init?: RequestInit) => {
    const shareId = String(url).match(/\/([^/]+)\.html$/)?.[1]
    if (init?.method === 'DELETE') {
      deleted.push(String(shareId))
      return new Response(null, { status: 204 })
    }
    return Response.json({ shareId, url: `https://share.example/${shareId}.html` })
  }
  const service = new ArtifactShareService({ identity: () => identity, request: request as typeof fetch })
  await fs.mkdir(identity.home, { recursive: true })
  const input = trustedInput(service, identity.home, 'file:session:report.md', '# Report')
  const first = await service.publish(input)
  assert.deepEqual(await service.inspect({ shareId: first.shareId }), first)
  identity = { accountId: 'B', home: path.join(root, 'B'), token: 'token-B' }
  assert.equal(await service.inspect({ shareId: first.shareId }), null)
  identity = ownerA
  assert.deepEqual(await service.inspect({ shareId: first.shareId }), first)
  await service.revoke(input.key, first.shareId)
  assert.equal(await service.inspect({ shareId: first.shareId }), null)
  const second = await service.publish(input)
  assert.notEqual(first.shareId, second.shareId)
  const before = deleted.length
  await assert.rejects(service.revoke(input.key, first.shareId), /状态已变化/)
  assert.equal(deleted.length, before)
  assert.deepEqual(await service.inspect({ shareId: second.shareId }), second)
})

test('有效期默认一天、可修改且内容更新不续期，清理失败跨重启重试，过期后新链接不复活旧链接', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-share-expiry-'))
  roots.push(root)
  let now = Date.now()
  let deleteFails = true
  const operations: string[] = []
  const request = async (url: string | URL | Request, init?: RequestInit) => {
    operations.push(String(init?.method))
    if (init?.method === 'DELETE') {return new Response(null, { status: deleteFails ? 503 : 204 })}
    const shareId = String(url).match(/\/([^/]+)\.html$/)?.[1]
    return Response.json({ shareId, url: `https://share.example/${shareId}.html` })
  }
  const deps = { identity: () => ({ accountId: 'A', home: root, token: 'A-token' }), now: () => now, request: request as typeof fetch }
  const service = new ArtifactShareService(deps)
  const input = trustedInput(service, root, 'file:session:report.md', '# First')
  const first = await service.publish(input)
  const day = 24 * 60 * 60 * 1000
  assert.equal(Date.parse(first.expiresAt!), now + day)
  const puts = operations.length
  for (const invalid of [0, 8, 1.5, NaN]) {
    await assert.rejects(service.setExpiration(input.key, first.shareId, invalid), /1～7/)
    await assert.rejects(service.publish({ ...input, ttlDays: invalid }), /1～7/)
  }
  assert.equal(operations.length, puts)
  now += day / 2
  const extended = await service.setExpiration(input.key, first.shareId, 3)
  assert.equal(extended.url, first.url)
  assert.equal(Date.parse(extended.expiresAt!), now + 3 * day)
  assert.equal(operations.length, puts)
  const updated = await service.publish(trustedInput(service, root, input.key, '# Second'))
  assert.equal(updated.expiresAt, extended.expiresAt)
  assert.equal(updated.shareId, first.shareId)
  now += 4 * day
  assert.deepEqual(await service.cleanupExpired(), { attempted: 1, failed: 1 })
  const restarted = new ArtifactShareService(deps)
  const pending = await restarted.inspect(input.key)
  assert.ok(pending?.cleanupError)
  assert.equal(pending.deletedAt, undefined)
  deleteFails = false
  assert.deepEqual(await restarted.cleanupExpired(), { attempted: 1, failed: 0 })
  assert.ok((await restarted.inspect(input.key))?.deletedAt)
  assert.deepEqual(await restarted.cleanupExpired(), { attempted: 0, failed: 0 })
  await assert.rejects(restarted.setExpiration(input.key, first.shareId, 1), /已取消|状态已变化/)
  const next = await restarted.publish(trustedInput(restarted, root, input.key, '# Second'))
  assert.notEqual(next.shareId, first.shareId)
  assert.ok((await restarted.inspect({ shareId: first.shareId }))?.deletedAt)
  await assert.rejects(restarted.revoke(input.key, first.shareId), /状态已变化/)
  assert.equal((await restarted.inspect(input.key))?.shareId, next.shareId)
})

test('账号 A→B→A 隔离清理，上传结果不明也保留到期清理，历史无期限记录不追溯删除', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-share-pending-expiry-'))
  roots.push(root)
  let now = Date.now()
  const accountA = { accountId: 'A', home: path.join(root, 'A'), token: 'A-token' }
  let identity = accountA
  const deleted: string[] = []
  let responseLost = true
  const request = async (url: string | URL | Request, init?: RequestInit) => {
    const id = String(url).match(/\/([^/]+)\.html$/)?.[1]
    if (init?.method === 'DELETE') {
      deleted.push(new Headers(init.headers).get('Authorization')!)
      return new Response(null, { status: 204 })
    }
    if (responseLost) {throw new Error('response lost')}
    return Response.json({ shareId: id, url: `https://share.example/${id}.html` })
  }
  const deps = { identity: () => identity, now: () => now, request: request as typeof fetch }
  const service = new ArtifactShareService(deps)
  await fs.mkdir(accountA.home, { recursive: true })
  const input = trustedInput(service, accountA.home, 'uncertain-upload', '# Pending')
  await assert.rejects(service.publish(input), /response lost/)
  now += 2 * 24 * 60 * 60 * 1000
  identity = { accountId: 'B', home: path.join(root, 'B'), token: 'B-token' }
  assert.deepEqual(await new ArtifactShareService(deps).cleanupExpired(), { attempted: 0, failed: 0 })
  assert.equal(deleted.length, 0)
  identity = accountA
  const cleanupErrors: unknown[] = []
  const stop = startArtifactShareCleanup(new ArtifactShareService(deps), error => cleanupErrors.push(error))
  try {
    await vi.waitFor(async () => {
      const names = await fs.readdir(path.join(accountA.home, 'desktop-artifact-shares'))
      assert.equal(names.filter(name => name.endsWith('.pending')).length, 0)
    }, { timeout: 2_000 })
  } finally {stop()}
  assert.deepEqual(cleanupErrors, [])
  assert.deepEqual(deleted, ['Bearer A-token'])
  assert.equal((await fs.readdir(path.join(accountA.home, 'desktop-artifact-shares'))).filter(name => name.endsWith('.pending')).length, 0)
  responseLost = false
  const record = await service.publish(input)
  const directory = path.join(accountA.home, 'desktop-artifact-shares')
  const filename = (await fs.readdir(directory)).find(name => name.endsWith('.json'))!
  const legacy = { ...record }
  delete legacy.expiresAt
  await fs.writeFile(path.join(directory, filename), JSON.stringify(legacy))
  now += 8 * 24 * 60 * 60 * 1000
  assert.deepEqual(await service.cleanupExpired(), { attempted: 0, failed: 0 })
  assert.equal((await service.inspect(input.key))?.expiresAt, undefined)
  const renewed = await service.setExpiration(input.key, legacy.shareId, 7)
  assert.equal(Date.parse(renewed.expiresAt!), now + 7 * 24 * 60 * 60 * 1000)
})
