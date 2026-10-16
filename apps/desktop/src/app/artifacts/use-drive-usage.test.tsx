import { createServer, get, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import type { CloudDriveRequest } from '../../../electron/login/contract'

import { useDriveUsage } from './use-drive-usage'

it('原生桥通过真实 HTTP 读取容量，空间 A→B→A 不接受迟到结果，刷新失败保留已确认容量', async () => {
  let oldA!: ServerResponse
  let aCount = 0
  let unavailable = false
  const routes: string[] = []

  const server = createServer((request, response) => {
    const route = new URL(request.url!, 'http://fixture').pathname
    response.setHeader('Content-Type', 'application/json')

    routes.push(route)

    if (unavailable) {
      response.writeHead(503)
      response.end(JSON.stringify({ ok: false, error: { code: 'UPSTREAM_UNAVAILABLE' } }))

      return
    }

    if (route === '/asset-spaces/a/usage' && aCount++ === 0) {
      oldA = response

      return
    }

    response.end(JSON.stringify({ used_bytes: route.includes('/b/') ? 22 : 42, total_bytes: 100 }))
  })

  let dispose: (() => void) | undefined

  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    vi.stubGlobal('hermesDesktop', {
      cloudDriveRequest: (input: CloudDriveRequest) =>
        new Promise((resolve, reject) => {
          get(origin + input.route, response => {
            let text = ''
            response.setEncoding('utf8')
            response.on('data', chunk => {
              text += chunk
            })
            response.on('end', () => {
              if (response.statusCode !== 200) {
                reject(new Error('Temporary read failure'))

                return
              }

              try {
                resolve(JSON.parse(text))
              } catch (error) {
                reject(error)
              }
            })
          }).on('error', reject)
        })
    })
    const hook = renderHook(({ space }) => useDriveUsage(space), { initialProps: { space: 'a' } })
    dispose = hook.unmount
    await waitFor(() => expect(oldA).toBeDefined())
    hook.rerender({ space: 'b' })
    await waitFor(() => expect(hook.result.current.usage?.used_bytes).toBe(22))
    hook.rerender({ space: 'a' })
    await waitFor(() => expect(hook.result.current.usage?.used_bytes).toBe(42))
    await act(async () => {
      oldA.end(JSON.stringify({ used_bytes: 99, total_bytes: 100 }))
    })
    expect(hook.result.current.usage?.used_bytes).toBe(42)
    unavailable = true
    act(() => hook.result.current.refresh())
    await waitFor(() => expect(hook.result.current.failed).toBe(true))
    expect(hook.result.current.usage).toEqual({ used_bytes: 42, total_bytes: 100 })
    expect(routes).toEqual([
      '/asset-spaces/a/usage',
      '/asset-spaces/b/usage',
      '/asset-spaces/a/usage',
      '/asset-spaces/a/usage'
    ])
  } finally {
    dispose?.()
    vi.unstubAllGlobals()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
