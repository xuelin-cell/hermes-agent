import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { startArtifactShareBridge } from './bridge'
import { ArtifactShareService } from './service'

test('本机发布桥要求随机凭证并复用分享服务', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'share-bridge-'))

  const request = async (url: string | URL | Request) => {
    const shareId = String(url).match(/\/([^/]+)\.html$/)?.[1]

    return Response.json({ shareId, url: `https://share.example/${shareId}.html` })
  }

  const service = new ArtifactShareService({
    identity: () => ({ accountId: 'A', home, token: 'login-token' }),
    request: request as typeof fetch
  })

  const bridge = await startArtifactShareBridge(service)

  try {
    const html = '<!doctype html><p>ready</p>'
    const headers = { Authorization: `Bearer ${bridge.env.HERMES_ARTIFACT_SHARE_TOKEN}` }

    for (const event of [
      { sessionId: 's', profileHome: home, type: 'context', fresh: true },
      { sessionId: 's', profileHome: home, type: 'inline', contents: [html] }
    ]) {
      const origin = await fetch(`${bridge.env.HERMES_ARTIFACT_SHARE_BRIDGE}/origin`, {
        method: 'POST', headers, body: JSON.stringify(event)
      })

      assert.equal(origin.status, 200)
    }

    const body = JSON.stringify({ key: 'session:report', html, title: 'report', source: { sessionId: 's', content: html } })
    const denied = await fetch(`${bridge.env.HERMES_ARTIFACT_SHARE_BRIDGE}/publish`, { method: 'POST', body })
    assert.equal(denied.status, 404)

    const malformed = await fetch(`${bridge.env.HERMES_ARTIFACT_SHARE_BRIDGE}/publish`, {
      method: 'POST', body, headers: { Authorization: `Bearer ${'é'.repeat(bridge.env.HERMES_ARTIFACT_SHARE_TOKEN.length)}` }
    })

    assert.equal(malformed.status, 404)

    const published = await fetch(`${bridge.env.HERMES_ARTIFACT_SHARE_BRIDGE}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridge.env.HERMES_ARTIFACT_SHARE_TOKEN}` },
      body
    })

    assert.equal(published.status, 200)
    const record = await published.json()
    assert.deepEqual(await service.inspect('session:report'), record)
    service.markUploaded('s')
    const blocked = await fetch(`${bridge.env.HERMES_ARTIFACT_SHARE_BRIDGE}/publish`, { method: 'POST', headers, body })
    assert.equal(blocked.status, 400)
  } finally {
    await bridge.stop()
    await fs.rm(home, { recursive: true, force: true })
  }
})
