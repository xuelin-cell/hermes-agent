import { once } from 'node:events'

import { afterEach, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'

import { UniworkAsrSession } from './session'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose()
  }
})

/** 用真实本地 WebSocket 走握手、音频和 EOF，不替换协议层。 */
async function fixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()

  if (typeof address === 'string' || !address) {
    throw new Error('本地端口不可用')
  }

  cleanup.push(() => {
    for (const client of server.clients) {
      client.terminate()
    }

    server.close()
  })
  let current = { owner: 'test-account', key: 'private-test-key', expiresAt: Date.now() + 60_000 }
  const connected = once(server, 'connection')

  const client = new UniworkAsrSession(
    current,
    () => current,
    (url, key) => {
      expect(url).toBe('wss://maas.ai-yuanjing.com/app/uniwork/asr')

      return new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Authorization: `Bearer ${key}` } })
    }
  )

  cleanup.push(() => client.cancel())
  const [peer, request] = await connected

  return {
    client,
    peer: peer as WebSocket,
    request,
    revoke: () => {
      current = null
    }
  }
}

it('主进程保管鉴权，发送PCM并在EOF后保留最后一句识别文字', async () => {
  const f = await fixture()
  expect(f.request.headers.authorization).toBe('Bearer private-test-key')
  const config = once(f.peer, 'message')
  await f.client.open('zh')
  expect(JSON.parse((await config)[0].toString()).config).toMatchObject({ samp_freq: 16000, language: 'zh' })
  const audio = once(f.peer, 'message')
  f.client.audio(new Uint8Array([1, 0, 2, 0]))
  expect([...((await audio)[0] as Buffer)]).toEqual([1, 0, 2, 0])
  f.peer.on('message', data => {
    if (data.toString() === '{"eof":1}') {
      f.peer.send(JSON.stringify({ result: { text: '尾句。' }, is_endpoint: true }))
      f.peer.close()
    }
  })
  const final = await f.client.stop()
  expect(final).toEqual({ transcripts: [{ text: '尾句。', final: true }], closed: true, failed: false })
})

it('账号撤销及过大的音频均关闭连接，拒绝继续发送', async () => {
  const revoked = await fixture()
  await revoked.client.open('zh')
  revoked.revoke()
  expect(() => revoked.client.audio(new Uint8Array([0, 0]))).toThrow('连接已结束')
  expect(revoked.client.isClosed).toBe(true)
  const oversized = await fixture()
  await oversized.client.open('en')
  expect(() => oversized.client.audio(new Uint8Array(40_000))).toThrow('音频传输失败')
  expect(oversized.client.isClosed).toBe(true)
})
