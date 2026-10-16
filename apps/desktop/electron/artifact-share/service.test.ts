import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { composeArtifactHtml } from '../../../shared/src/artifact-share'

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
