import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'

import type { ArtifactSharePublishInput, ArtifactShareSource } from '../../../shared/src/artifact-share'

import type { OriginEvent } from './origins'
import type { ArtifactShareService } from './service'

const MAX_REQUEST_BYTES = 2 * 1024 * 1024 + 8192

export interface ArtifactShareBridge {
  env: { HERMES_ARTIFACT_SHARE_BRIDGE: string; HERMES_ARTIFACT_SHARE_TOKEN: string }
  stop: () => Promise<void>
}

/** 为桌面启动的本地后端提供只含分享操作的 loopback 接口。 */
export async function startArtifactShareBridge(service: ArtifactShareService): Promise<ArtifactShareBridge> {
  const token = randomBytes(32).toString('base64url')

  const server = http.createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '')
    const expected = Buffer.from(token)
    const valid = supplied.length === expected.length && timingSafeEqual(supplied, expected)

    if (!valid || request.method !== 'POST' || !['/publish', '/origin', '/eligibility'].includes(request.url ?? '')) {
      response.writeHead(404).end()

      return
    }

    try {
      const chunks: Buffer[] = []
      let size = 0

      for await (const chunk of request) {
        size += chunk.length

        if (size > MAX_REQUEST_BYTES) {
          throw new Error('分享请求过大。')
        }

        chunks.push(chunk)
      }

      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))

      if (!input || typeof input !== 'object') {
        throw new Error('分享请求无效。')
      }

      let result: unknown

      if (request.url === '/origin') {
        service.recordOrigin(input as OriginEvent)
        result = { ok: true }
      } else if (request.url === '/eligibility') {
        result = service.eligibility(input as ArtifactShareSource)
      } else {
        result = await service.publish(input as ArtifactSharePublishInput)
      }

      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()

  if (!address || typeof address === 'string') {
    throw new Error('分享桥启动失败。')
  }

  return {
    env: { HERMES_ARTIFACT_SHARE_BRIDGE: `http://127.0.0.1:${address.port}`, HERMES_ARTIFACT_SHARE_TOKEN: token },
    stop: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  }
}
