import { expect, it, vi } from 'vitest'

import { fetchPlan } from './plan'

const catalog = {
  main_model_id: 'second',
  models: [
    { id: 'first', model: 'same-model', base_url: 'https://models.invalid/TokenPlan/first/' },
    { id: 'second', model: 'same-model', base_url: 'https://models.invalid/TokenPlan/second/v1/' },
    { id: 3, base_url: 'http://localhost:9000/custom' }
  ]
}

it('带登录 token 查询固定套餐地址，解析对象或字符串目录并保留同名不同端点和主模型', async () => {
  const request = vi.fn<typeof fetch>()
  const cancellation = new AbortController()

  for (const models of [catalog, JSON.stringify(catalog)]) {
    request.mockResolvedValueOnce(Response.json({ code: 0, data: { apiKey: 'private-model-key', models } }))
    const result = await fetchPlan(request, 'private-login-token', cancellation.signal)
    expect(result).toEqual({
      status: 'available',
      plan: {
        apiKey: 'private-model-key',
        mainModelIndex: 1,
        models: [
          { id: 'first', name: 'same-model', baseUrl: 'https://models.invalid/TokenPlan/first/v1' },
          { id: 'second', name: 'same-model', baseUrl: 'https://models.invalid/TokenPlan/second/v1' },
          { id: '3', name: '3', baseUrl: 'http://localhost:9000/custom/v1' }
        ]
      }
    })
  }

  for (const main_model_id of [undefined, 'missing', 3]) {
    request.mockResolvedValueOnce(Response.json({ apiKey: 'key', models: { ...catalog, main_model_id } }))
    const result = await fetchPlan(request, 'token', cancellation.signal)
    expect(result.status).toBe('available')

    if (result.status === 'available') {
      expect(result.plan.mainModelIndex).toBe(main_model_id === 3 ? 2 : 0)
    }
  }

  const [url, options] = request.mock.calls[0]
  expect(url).toBe('https://maas.ai-yuanjing.com/app/gateway/uniwork/my-plan')
  expect(options).toMatchObject({
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: 'Bearer private-login-token' },
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store'
  })
  expect(options!.body).toBeUndefined()
  expect(request).toHaveBeenCalledTimes(5)
})

it('显式空套餐与查询失败分开；缺 Key、坏目录、错误地址、网络和超时均不当作空套餐', async () => {
  const request = vi.fn<typeof fetch>()
  const cancellation = new AbortController()
  request.mockResolvedValueOnce(Response.json({ apiKey: null, models: null }))
  expect(await fetchPlan(request, 'token', cancellation.signal)).toEqual({ status: 'empty' })

  for (const body of [
    null,
    {},
    [],
    { code: 9, data: { apiKey: null, models: null } },
    { data: [], apiKey: 'key', models: catalog },
    { models: catalog },
    { apiKey: '', models: catalog },
    { apiKey: 123, models: catalog },
    { apiKey: 'key', models: null },
    { apiKey: 'key', models: 'bad-json' },
    { apiKey: 'key', models: { models: [] } },
    { apiKey: 'key', models: { models: [null] } },
    { apiKey: 'key', models: { ...catalog, main_model_id: {} } },
    ...[
      {},
      { model: 'name' },
      { model: 'name', base_url: 'invalid' },
      { model: 'name', base_url: 'file:///tmp/model' },
      { model: 'name', base_url: 'https://user:secret@models.invalid/path' },
      { model: 'name', base_url: 'https://models.invalid/path?key=secret' },
      { id: Number.MAX_SAFE_INTEGER + 1, base_url: 'https://models.invalid/path' }
    ].map(model => ({ apiKey: 'key', models: { models: [model] } }))
  ]) {
    request.mockResolvedValueOnce(Response.json(body))
    expect(await fetchPlan(request, 'token', cancellation.signal)).toEqual({ status: 'failed' })
  }

  for (const response of [
    new Response('private-response'),
    new Response('private', { status: 429 }),
    new Response('private', { status: 503 })
  ]) {
    request.mockResolvedValueOnce(response)
    expect(await fetchPlan(request, 'token', cancellation.signal)).toEqual({ status: 'failed' })
  }

  request.mockRejectedValueOnce(new Error('private-network-detail'))
  expect(await fetchPlan(request, 'token', cancellation.signal)).toEqual({ status: 'failed' })

  const timeoutController = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
  request.mockImplementationOnce(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error('private-timeout')), { once: true })
      })
  )
  const pending = fetchPlan(request, 'token', cancellation.signal)
  expect(timeout).toHaveBeenCalledWith(15_000)
  timeoutController.abort()
  expect(await pending).toEqual({ status: 'failed' })
  timeout.mockRestore()
})

it('仅明确 HTTP 鉴权拒绝提示重登；服务器和网络失败不推断过期', async () => {
  const request = vi.fn<typeof fetch>()

  for (const status of [401, 403, 429, 500]) {
    request.mockResolvedValueOnce(new Response('private-error', { status }))
    expect(await fetchPlan(request, 'token', new AbortController().signal)).toEqual(
      status === 401 || status === 403 ? { status: 'failed', reason: 'auth' } : { status: 'failed' }
    )
  }

  request.mockRejectedValueOnce(new Error('network'))
  expect(await fetchPlan(request, 'token', new AbortController().signal)).toEqual({ status: 'failed' })
})
