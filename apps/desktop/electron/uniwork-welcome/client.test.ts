import { once } from 'node:events'
import { createServer } from 'node:http'

import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch } }))
import { normalizeWelcomeCatalog } from './catalog'
import { WelcomeCatalogClient } from './client'

it('reads V3 anonymously at boot, forwards current login credentials, and rejects unusable or extra-escaped payloads', async () => {
  let authorization: string | undefined
  let envelopeOverride: unknown

  const server = createServer((request, response) => {
    authorization = request.headers.authorization
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify(
        envelopeOverride ?? {
          version: ' version-1 ',
          configValue: JSON.stringify({
            modules: [
              {
                id: 'arbitrary',
                name: 'Configured office',
                enabled: true,
                tags: [
                  {
                    id: 'docs',
                    name: 'Docs',
                    sort: 10,
                    enabled: true,
                    templates: [{ id: 'one', name: 'One', prompt: 'Create a report', sort: 10, enabled: true }]
                  }
                ]
              }
            ]
          })
        }
      )
    )
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  try {
    const address = server.address()

    if (!address || typeof address === 'string') {
      throw new Error('本地HTTP端口不可用')
    }

    let signedIn = false
    const identity = { uid: 'test', token: 'private-token', maskedPhone: '138****0000', expiresAt: Date.now() + 60_000 }

    const client = new WelcomeCatalogClient(
      async (input, options) => {
        expect(String(input)).toBe(
          'https://maas.ai-yuanjing.com/app/gateway/uniwork/system-config?key=welcome_config_v3_zh-CN'
        )

        return fetch(`http://127.0.0.1:${address.port}`, options)
      },
      () => (signedIn ? identity : null)
    )

    const result = await client.load('zh-CN')
    expect(authorization).toBeUndefined()
    expect(normalizeWelcomeCatalog(result)[0].tags[0].templates[0].prompt).toBe('Create a report')
    expect(result.version).toBe('version-1')
    expect(JSON.stringify(result)).not.toContain('private-token')
    expect(result.modules[0]).not.toHaveProperty('workspace')
    signedIn = true
    await client.load('zh-CN')
    expect(authorization).toBe('Bearer private-token')
    envelopeOverride = { configValue: JSON.stringify(JSON.stringify({ modules: [{ name: 'code' }] })) }
    await expect(client.load('zh-CN')).rejects.toThrow('更新失败')
    envelopeOverride = { configValue: JSON.stringify({ modules: [] }) }
    await expect(client.load('zh-CN')).rejects.toThrow('更新失败')
    await expect(client.load('forged' as never)).rejects.toThrow('语言无效')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  }
})
