import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'

import type { TitleModelService } from './service'

/** 只向受管后端传递本机短期凭证；套餐Key留在主进程，接口不接受模型或端点。 */
export async function startTitleBridge(service: TitleModelService) {
  const token = randomBytes(32).toString('base64url')

  const server = http.createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '')
    const expected = Buffer.from(token)

    if (
      request.method !== 'POST' ||
      request.url !== '/title' ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      response.writeHead(404).end()

      return
    }

    try {
      let size = 0
      const chunks: Buffer[] = []

      for await (const chunk of request) {
        size += chunk.length

        if (size > 20000) {
          response.writeHead(413).end()

          return
        }

        chunks.push(chunk)
      }

      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))

      if (
        typeof body.intent !== 'string' ||
        typeof body.material !== 'string' ||
        body.intent.length > 1800 ||
        body.material.length > 2400 ||
        Object.keys(body).some(key => !['intent', 'material'].includes(key))
      ) {
        response.writeHead(400).end()

        return
      }

      const result = await service.generate(body)
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
    } catch {
      response.writeHead(400).end()
    }
  })

  server.requestTimeout = 12000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  server.unref()
  const address = server.address()

  if (!address || typeof address === 'string') {
    throw new Error('标题服务启动失败')
  }

  return {
    env: { UNIWORK_TITLE_BRIDGE: `http://127.0.0.1:${address.port}/title`, UNIWORK_TITLE_TOKEN: token },
    stop: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  }
}
