import { once } from 'node:events'
import { createServer } from 'node:http'

import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch } }))
import { WelcomeCatalogClient } from './client'

it('匿名读取固定uniwork配置地址，解包modules并保留对应的tags和templates', async () => {
  let authorization: string | undefined

  const server = createServer((request, response) => {
    authorization = request.headers.authorization
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
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
      })
    )
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  try {
    const address = server.address()

    if (!address || typeof address === 'string') {
      throw new Error('本地HTTP端口不可用')
    }

    const client = new WelcomeCatalogClient(async (input, options) => {
      expect(String(input)).toBe(
        'https://maas.ai-yuanjing.com/app/gateway/uniwork/system-config?key=welcome_config_codex_zh-CN'
      )

      return fetch(`http://127.0.0.1:${address.port}`, options)
    })

    const result = await client.load('zh-CN')
    expect(authorization).toBeUndefined()
    expect(result[0].tags[0].templates[0].prompt).toBe('Create a report')
    expect(JSON.stringify(result)).not.toContain('private-token')
    await expect(client.load('forged' as never)).rejects.toThrow('语言无效')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  }
})
