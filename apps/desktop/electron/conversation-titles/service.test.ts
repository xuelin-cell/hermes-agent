import { describe, expect, it, vi } from 'vitest'

import type { FetchedPlan } from '../login/plan'

import { startTitleBridge } from './bridge'
import { cleanTitle, TitleModelService } from './service'

const plan: FetchedPlan = {
  status: 'available',
  plan: {
    apiKey: 'test-plan-key',
    mainModelIndex: 0,
    models: [{ id: '1', name: 'digital-worker-model', baseUrl: 'https://plan.example/v1' }]
  }
}

const answer = () =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '产品推广方案制定' } }] }))

describe('数字员工标题服务', () => {
  it('只用可信套餐端点、模型和Key，并缩短输入', async () => {
    const request = vi.fn(async () => answer())

    const result = await new TitleModelService(() => plan, request).generate({
      intent: '用户意图'.repeat(1000),
      material: '材料'.repeat(2000)
    })

    expect(result).toEqual({ status: 'ready', title: '产品推广方案制定' })
    const [url, init] = request.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.href).toBe('https://plan.example/v1/chat/completions')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-plan-key' })
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('digital-worker-model')
    expect(body.messages).toHaveLength(2)
    const evidence = JSON.parse(body.messages[1].content)
    expect(evidence.intent.length).toBe(1800)
    expect(evidence.material.length).toBe(2400)
  })
  it('没有套餐、额度不足或模型错误均不调用Hermes备用资源', async () => {
    const request = vi.fn(async () => new Response('', { status: 402 }))
    expect(
      await new TitleModelService(() => ({ status: 'empty' }), request).generate({ intent: '问题', material: '' })
    ).toMatchObject({ status: 'unavailable' })
    expect(request).not.toHaveBeenCalled()
    expect(await new TitleModelService(() => plan, request).generate({ intent: '问题', material: '' })).toMatchObject({
      status: 'unavailable'
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('两个标题并行，第三个退让，完成一个只释放一个槽位', async () => {
    const releases: Array<(value: Response) => void> = []
    const request = vi.fn(() => new Promise<Response>(resolve => { releases.push(resolve) }))
    const service = new TitleModelService(() => plan, request)
    const first = service.generate({ intent: '第一条', material: '' })
    const second = service.generate({ intent: '第二条', material: '' })

    try {
      expect(request).toHaveBeenCalledTimes(2)
      expect(await service.generate({ intent: '第三条', material: '' })).toMatchObject({ status: 'deferred', reason: 'busy_or_cooldown' })
      releases[0](answer())
      expect(await first).toMatchObject({ status: 'ready' })
      const third = service.generate({ intent: '第三条', material: '' })
      expect(request).toHaveBeenCalledTimes(3)
      expect(await service.generate({ intent: '第四条', material: '' })).toMatchObject({ status: 'deferred' })
      releases[1](answer())
      releases[2](answer())
      expect(await second).toMatchObject({ status: 'ready' })
      expect(await third).toMatchObject({ status: 'ready' })
    } finally {
      for (const release of releases) {release(answer())}
      await Promise.all([first, second])
    }
  })
  it('限流冷却、截断回复和超长标题不会保存', async () => {
    const request = vi.fn(async () => new Response('', { status: 429 }))
    const service = new TitleModelService(() => plan, request)
    expect(await service.generate({ intent: '问题', material: '' })).toMatchObject({
      status: 'deferred',
      attempted: true
    })
    await service.generate({ intent: '问题', material: '' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(cleanTitle('汉'.repeat(17))).toBeNull()
    expect(cleanTitle('汉'.repeat(16))).not.toBeNull()
    expect(cleanTitle('Hermes' + '汉'.repeat(11))).toBeNull()
    expect(cleanTitle('👩‍💻'.repeat(16))).not.toBeNull()
    expect(cleanTitle('👩‍💻'.repeat(17))).toBeNull()

    const limited = new TitleModelService(
      () => plan,
      async () =>
        new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '半截标题' } }] }))
    )

    expect(await limited.generate({ intent: '问题', material: '' })).toMatchObject({ status: 'unavailable', reason: 'truncated', attempted: true })
  })
  it('本机桥必须鉴权，调用者不能指定Key、端点或模型', async () => {
    const request = vi.fn(async () => answer()),
      bridge = await startTitleBridge(new TitleModelService(() => plan, request))

    try {
      expect((await fetch(bridge.env.UNIWORK_TITLE_BRIDGE, { method: 'POST', body: '{}' })).status).toBe(404)
      const options = { method: 'POST', headers: { Authorization: `Bearer ${bridge.env.UNIWORK_TITLE_TOKEN}` } }
      expect(
        (
          await fetch(bridge.env.UNIWORK_TITLE_BRIDGE, {
            ...options,
            body: JSON.stringify({ intent: '问题', material: '', model: 'solar-pro4:free' })
          })
        ).status
      ).toBe(400)

      const response = await fetch(bridge.env.UNIWORK_TITLE_BRIDGE, {
        ...options,
        body: JSON.stringify({ intent: '推广方案', material: '' })
      })

      expect(await response.json()).toEqual({ status: 'ready', title: '产品推广方案制定' })
      expect(request).toHaveBeenCalledTimes(1)
    } finally {
      await bridge.stop()
    }
  })
})


describe('标题失败分类与日志', () => {
  it.each([
    ['NONE', 'insufficient', 'no_topic'],
    ['汉'.repeat(17), 'deferred', 'invalid_title'],
    ['标题一\n说明内容', 'deferred', 'invalid_title'],
    ['', 'deferred', 'invalid_title']
  ])('区分缺主题与无效标题：%s', async (content, status, reason) => {
    const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] })))
    const result = await new TitleModelService(() => plan, request, () => undefined).generate({ intent: '', material: '已读取的文件主题内容' })
    expect(result).toMatchObject({ status, reason, attempted: true })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['{broken', 'malformed_response'],
    ['null', 'invalid_finish'],
    ['x'.repeat(17000), 'response_too_large']
  ])('异常响应进入有界重试：%s', async (body, reason) => {
    const result = await new TitleModelService(() => plan, async () => new Response(body), () => undefined).generate({ intent: '问题', material: '' })
    expect(result).toMatchObject({ status: 'deferred', reason, attempted: true })
  })

  it('日志仅包含状态长度耗时，不带用户输入、模型回复、套餐Key或端点', async () => {
    const log = vi.fn()
    const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '机密业务标题' } }] })))
    await new TitleModelService(() => plan, request, log).generate({ intent: '机密输入', material: '机密材料' })
    const recorded = log.mock.calls.flat().join('')
    expect(recorded).toContain('elapsedMs')
    expect(recorded).toContain('ready')

    for (const secret of ['机密输入', '机密材料', '机密业务标题', 'test-plan-key', 'https://plan.example']) {
      expect(recorded).not.toContain(secret)
    }
  })
})


it.each([
  ['从这个页面挑3条适合鼓励自己的名言，列出作者，再各写一句中文解释。', '励志名言筛选与解读'],
  ['写产品文档可以直接用example.com和example.org举例吗？需要申请吗？', '文档示例域名使用规则']
])('短输入不因响应预算过小被截断：%s', async (intent, title) => {
  // 替身模拟包括推理开销的响应；只检查请求/响应契约，不冒充真实模型效果。
  const request = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string)
    const enough = body.max_tokens >= 200

    return new Response(JSON.stringify({ choices: [{ finish_reason: enough ? 'stop' : 'length', message: { content: enough ? title : '' } }], usage: { completion_tokens: 180 } }))
  })

  const service = new TitleModelService(() => plan, request, () => undefined)
  expect(await service.generate({ intent, material: '' })).toEqual({ status: 'ready', title })
  expect(request).toHaveBeenCalledTimes(1)
  const body = JSON.parse(request.mock.calls[0][1]!.body as string)
  expect(body.max_tokens).toBeLessThanOrEqual(512)
  expect(JSON.parse(body.messages[1].content).material).toBe('')
})

it('脱敏指标能区分思考开销与正文截断，不能泄露模型输出', async () => {
  const log = vi.fn()
  const response = { choices: [{ finish_reason: 'length', message: { content: '机密正文', reasoning_content: '机密推理' } }], usage: { completion_tokens: 512, completion_tokens_details: { reasoning_tokens: 500 } } }
  const result = await new TitleModelService(() => plan, async () => new Response(JSON.stringify(response)), log).generate({ intent: '机密输入', material: '' })
  expect(result).toMatchObject({ status: 'unavailable', reason: 'truncated', attempted: true })
  const text = log.mock.calls.flat().join('')
  expect(text).toContain('"completionTokens":512')
  expect(text).toContain('"reasoningTokens":500')

  for (const secret of ['机密正文', '机密推理', '机密输入', 'test-plan-key']) {expect(text).not.toContain(secret)}
})


it('单次超时短暂退让，不为其他会话启动全局冷却', async () => {
  const request = vi.fn(async () => answer()).mockRejectedValueOnce(new DOMException('超时', 'TimeoutError'))
  const service = new TitleModelService(() => plan, request)
  expect(await service.generate({ intent: '生成少女望夕阳的油画', material: '' })).toMatchObject({ status: 'deferred', reason: 'timeout', retryAfter: 2, attempted: true })
  expect(await service.generate({ intent: '规划婺源旅行', material: '' })).toMatchObject({ status: 'ready' })
  expect(request).toHaveBeenCalledTimes(2)
})


it.each([
  ['https://maas-api.ai-yuanjing.com/openapi/compatible-mode/v1', 'deepseek-v4-flash', true],
  ['https://maas-api.ai-yuanjing.com.other.example/v1', 'deepseek-v4-flash', false],
  ['https://maas-api.ai-yuanjing.com/openapi/compatible-mode/v1', 'other-model', false]
])('元景已验证路由使用模板关闭思考，不改其他路由：%s %s', async (baseUrl, name, templateControl) => {
  const selected: FetchedPlan = { status: 'available', plan: { apiKey: 'isolated-key', mainModelIndex: 0, models: [{ id: '1', name, baseUrl }] } }
  const original = structuredClone(selected)
  const request = vi.fn(async () => answer())
  expect(await new TitleModelService(() => selected, request).generate({ intent: '周末婺源赏枫两天', material: '' })).toMatchObject({ status: 'ready' })
  const [, options] = request.mock.calls[0] as unknown as [URL, RequestInit]
  const body = JSON.parse(options.body as string)

  if (templateControl) {
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body.thinking).toEqual({ type: 'disabled' })
  } else {
    expect(body).not.toHaveProperty('chat_template_kwargs')
  }

  expect(selected).toEqual(original)
})
