import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { composeArtifactHtml } from '../../../shared/src/artifact-share'

import { originHash } from './origins'
import { ArtifactShareService } from './service'

test('来源与字节一致才发布，上传事实跨重启及账号切换仍不可洗白', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-test-'))

  try {
    const homeA = path.join(root, 'A')
    const homeB = path.join(root, 'B')
    fs.mkdirSync(homeA)
    fs.mkdirSync(homeB)
    const file = path.join(root, 'page.html')
    const html = '<h1>model</h1>'
    fs.writeFileSync(file, html)
    let identity = { accountId: 'A', home: homeA, token: 'test' }
    let uploads = 0

    const request = async (url: string | URL | Request) => {
      uploads++
      const shareId = String(url).match(/\/([^/]+)\.html$/)![1]

      return Response.json({ shareId, url: `https://share.example/${shareId}.html` })
    }

    const service = new ArtifactShareService({ identity: () => identity, request: request as typeof fetch })
    const source = { sessionId: 's', path: file, hash: originHash(html) }
    const input = { key: 'file:s:page', title: 'page', html, source }
    await assert.rejects(service.publish(input), /来源/)
    service.recordOrigin({ sessionId: 's', profileHome: homeA, type: 'context', fresh: true })
    service.recordOrigin({ sessionId: 's', profileHome: homeA, type: 'files', files: [{ path: file, hash: source.hash, replace: true }] })
    await service.publish(input)
    fs.writeFileSync(file, '<p>external edit</p>')
    await assert.rejects(service.publish(input), /来源/)
    service.markUploaded('s')
    const renamed = path.join(root, 'renamed.html')
    fs.copyFileSync(file, renamed)
    service.recordOrigin({ sessionId: 's', profileHome: homeA, type: 'context', fresh: true, hasUploads: false })
    service.recordOrigin({ sessionId: 's', profileHome: homeA, type: 'files', files: [{ path: renamed, hash: originHash(fs.readFileSync(renamed)), replace: true }] })
    const restarted = new ArtifactShareService({ identity: () => identity, request: request as typeof fetch })
    assert.equal(restarted.eligibility({ ...source, path: renamed }).reason, 'user_upload')
    identity = { accountId: 'B', home: homeB, token: 'B' }
    assert.equal(restarted.eligibility(source).reason, 'unknown_origin')
    identity = { accountId: 'A', home: homeA, token: 'A' }
    await assert.rejects(restarted.publish(input), /来源/)
    assert.equal(uploads, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('对话内 HTML 必须匹配完成回复，同名会话不可跨 profile 认领来源', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-inline-'))

  try {
    const profile = path.join(home, 'profiles', 'work')
    fs.mkdirSync(profile, { recursive: true })
    const service = new ArtifactShareService({ identity: () => ({ accountId: 'A', home, token: 'test' }) })
    const source = { sessionId: 's', content: '<p>confirmed</p>' }
    service.recordOrigin({ sessionId: 's', profileHome: profile, type: 'context', fresh: true })
    service.recordOrigin({ sessionId: 's', profileHome: profile, type: 'inline', contents: [source.content] })
    assert.equal(service.eligibility(source).publishable, true)
    service.recordOrigin({ sessionId: 'child', parentSessionId: 's', profileHome: profile, type: 'context', fresh: false })
    assert.equal(service.eligibility({ ...source, sessionId: 'child' }).publishable, true)
    await assert.rejects(service.publish({ key: 'artifact:s:test', title: 'test', html: composeArtifactHtml('<p>forged</p>'), source }), /不一致/)
    assert.throws(() => service.recordOrigin({ sessionId: 's', profileHome: home, type: 'context', fresh: true }), /profile/)
    assert.equal(service.eligibility({ sessionId: 'unknown', content: source.content }).publishable, false)
    service.markUploaded('s')
    assert.equal(service.eligibility({ ...source, sessionId: 'child' }).reason, 'user_upload')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
