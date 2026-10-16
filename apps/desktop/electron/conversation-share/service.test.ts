import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import type { ConversationSnapshot } from '../../../shared/src/conversation-share'

import { ConversationShareService } from './service'

const roots: string[] = []
const html = '<!doctype html><html><head></head><body><p>你好</p></body></html>'
const owner = { connectionId: 'local', profile: 'default' }
const input = { sessionId: 'session', scope: 'session' as const }

/** 构造可变后端快照，验证主进程再次读取来源。 */
function snapshot(version = 'a'): ConversationSnapshot {
  return {
    revision: version.repeat(64),
    sessionId: 'session',
    document: {
      schemaVersion: 1,
      snapshotId: version.repeat(64),
      scope: 'session',
      title: '你好',
      locale: 'zh',
      theme: 'light',
      rendererVersion: 1,
      messages: [{ role: 'assistant', blocks: [{ type: 'markdown', text: '你好' }] }]
    }
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

test('不可变快照复用、响应丢失重试和撤销后重新发布经过真实存储', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-share-'))
  roots.push(home)
  let current = snapshot()
  const calls: string[] = []
  const bodies: string[] = []
  let failUpload = true
  let failDelete = true
  const identity = () => ({ accountId: 'A', home, token: 'secret' })

  const request: typeof fetch = async (url, options) => {
    const id = String(url).match(/\/([^/]+)\.html$/)?.[1] ?? ''
    calls.push(`${options?.method} ${id}`)
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer secret')

    if (options?.method === 'DELETE') {
      return new Response(null, { status: failDelete ? 503 : 204 })
    }

    const body = new TextDecoder().decode(options?.body as Uint8Array)
    bodies.push(body)
    assert.match(body, /Content-Security-Policy/)

    if (failUpload) {
      failUpload = false
      throw new Error('response lost')
    }

    return Response.json({ shareId: id, url: `https://share.example/${id}.html` })
  }

  const image = Buffer.from('image bytes')
  current.document.assets = [
    { reference: 'figure.png', path: '/workspace/figure.png', hash: createHash('sha256').update(image).digest('hex') }
  ]
  let imageChanged = false

  const deps = {
    identity,
    request,
    readSnapshot: async () => current,
    readImage: async (route: typeof owner, sessionId: string, filePath: string) => {
      assert.deepEqual(route, owner)
      assert.equal(sessionId, input.sessionId)
      assert.equal(filePath, '/workspace/figure.png')

      return {
        dataUrl: `data:image/png;base64,${imageChanged ? Buffer.from('changed').toString('base64') : image.toString('base64')}`
      }
    }
  }

  let service = new ConversationShareService(deps)
  let prepared = await service.prepare(owner, input)
  await assert.rejects(service.image(prepared.ticket, 'private.png'), /未在可信快照/)
  assert.equal(await service.image(prepared.ticket, 'figure.png'), `data:image/png;base64,${image.toString('base64')}`)
  imageChanged = true
  await assert.rejects(service.image(prepared.ticket, 'figure.png'), /图片内容已变化/)
  await assert.rejects(service.publish(prepared.ticket, html), /response lost/)
  service = new ConversationShareService(deps)
  prepared = await service.prepare(owner, input)
  const first = await service.publish(prepared.ticket, html.replace('你好', '重试时渲染器变化'))
  assert.equal(bodies[0], bodies[1])
  assert.equal(calls[0], calls[1])
  assert.equal((await service.publish(prepared.ticket, html.replace('你好', '新版'))).url, first.url)
  assert.equal(calls.length, 2)
  current = snapshot('b')
  await assert.rejects(service.publish(prepared.ticket, html), /变化/)
  prepared = await service.prepare(owner, input)
  const second = await service.publish(prepared.ticket, html)
  assert.notEqual(first.shareId, second.shareId)
  await assert.rejects(service.revoke(second.key), /503/)
  assert.equal((await service.list(owner, input.sessionId)).find(item => item.key === second.key)?.state, 'published')
  failDelete = false
  await service.revoke(second.key)
  assert.notEqual((await service.publish(prepared.ticket, html)).shareId, second.shareId)
})

test('账号 A→B→A、后端及 profile 隔离，阻止取消和迟到上传', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-owner-'))
  roots.push(root)
  let identity = { accountId: 'A', home: path.join(root, 'A'), token: 'secret' }
  const a = identity
  let finish: (() => void) | undefined
  let uploading: (() => void) | undefined

  const started = new Promise<void>(resolve => {
    uploading = resolve
  })

  const request: typeof fetch = async url => {
    uploading?.()
    await new Promise<void>(resolve => {
      finish = resolve
    })
    const id = String(url).match(/\/([^/]+)\.html$/)?.[1]

    return Response.json({ shareId: id, url: `https://share.example/${id}.html` })
  }

  const service = new ConversationShareService({
    identity: () => identity,
    request,
    readSnapshot: async () => snapshot()
  })

  const prepared = await service.prepare(owner, input)
  const operation = service.publish(prepared.ticket, html)
  await started
  identity = { accountId: 'B', home: path.join(root, 'B'), token: 'B-token' }
  finish?.()
  await assert.rejects(operation, /账号已切换/)
  assert.deepEqual(await service.list(owner, input.sessionId), [])
  identity = a
  assert.equal((await service.list(owner, input.sessionId))[0]?.state, 'pending')
  assert.deepEqual(await service.list({ ...owner, profile: 'other' }, input.sessionId), [])
  assert.deepEqual(await service.list({ ...owner, connectionId: 'remote' }, input.sessionId), [])
  service.cancel(prepared.ticket)
  await assert.rejects(service.publish(prepared.ticket, html), /失效/)
  const unsafe = await service.prepare(owner, input)
  await assert.rejects(service.publish(unsafe.ticket, '<script>alert(1)</script>'), /静态文档/)
})
