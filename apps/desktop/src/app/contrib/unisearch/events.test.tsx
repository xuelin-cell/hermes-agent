import type { GatewayEvent } from '@hermes/shared'
import { act, cleanup, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { renderMessageStream } from '@/app/session/hooks/use-message-stream/test-harness'
import { decodeWebResult, webProviderLabel } from '@/components/assistant-ui/tool/search-cards/provider'
import { searchCards } from '@/components/assistant-ui/tool/search-cards/result'

import { createUniSearchEvents } from './events'

const owner = { connectionId: 'local', profile: 'default' }

const result = {
  provider: 'unisearch',
  query: '股票',
  success: true,
  data: { web: [], cards: [{ type: 'stock', raw: { _canonical: { name: '示例', price: '123' } } }] }
}

/** 构造只含身份信息的通知，不将私密正文加入广播。 */
const notice = (phase: string, patch: Record<string, unknown> = {}) =>
  ({
    type: 'plugin.unisearch.tool.' + phase,
    payload: {
      session_id: 'stored',
      tool_call_id: 'call',
      tool_name: 'web_search',
      provider: 'unisearch',
      profile: 'default',
      turn_id: 'turn',
      timestamp: 101,
      ...patch
    }
  }) as unknown as GatewayEvent

/** 历史夹具保留真实工具消息结构，供准确owner读取。 */
const page = () => ({
  session_id: 'stored',
  profile: 'default',
  messages: [
    {
      role: 'tool' as const,
      content: JSON.stringify(result),
      tool_call_id: 'call',
      tool_name: 'web_search',
      timestamp: 103
    }
  ]
})

afterEach(cleanup)

it.each([false, true])(
  'uses the real stream lifecycle with native chrome %s: cards attach once after final text and duplicate events preserve args',
  async nativeChrome => {
    const stream = renderMessageStream('runtime')
    /** 只发送身份通知以驱动事件适配，结果沿准确owner的历史接口取得。 */
    const send = (event: GatewayEvent) => act(() => stream.handleEvent(event))
    send({ type: 'message.start', session_id: 'runtime', payload: { timestamp: 100 } })
    const read = vi.fn(async () => page())

    const bridge = createUniSearchEvents({
      route: () => ({ runtimeId: 'runtime', storedId: 'stored', owner, interrupted: false }),
      read,
      dispatch: send
    })

    if (nativeChrome) {
      send({
        type: 'tool.start',
        session_id: 'runtime',
        payload: { name: 'web_search', tool_id: 'call', args: { query: '股票' }, timestamp: 101 }
      })
    }

    act(() => {
      bridge(notice('start'))
      bridge(notice('start'))
    })
    send({ type: 'message.complete', session_id: 'runtime', payload: { text: '查询完成', timestamp: 104 } })

    if (nativeChrome) {
      const native = {
        type: 'tool.complete',
        session_id: 'runtime',
        payload: { name: 'web_search', tool_id: 'call', result, timestamp: 103 }
      } as GatewayEvent

      if (!bridge(native)) {
        send(native)
      }
    }

    act(() => {
      bridge(notice('complete'))
      bridge(notice('complete'))
    })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(nativeChrome ? 0 : 1))
    await waitFor(() => {
      const parts = stream
        .state('runtime')
        .messages.flatMap(m => m.parts)
        .filter(p => p.type === 'tool-call')

      expect(parts).toHaveLength(1)
      expect(parts[0]).toMatchObject({ args: { query: '股票' }, result })
      expect(searchCards((parts[0] as { result: unknown }).result)).toHaveLength(1)
    })
    expect(
      bridge({ type: 'tool.complete', session_id: 'runtime', payload: { name: 'web_search', tool_id: 'call', result } })
    ).toBe(true)
    expect(bridge({ type: 'tool.start', session_id: 'runtime', payload: { name: 'terminal', tool_id: 'call' } })).toBe(
      false
    )
    expect(stream.state('runtime').streamId).toBeNull()
  }
)

it.each([
  ['unknown owner', undefined, {}],
  [
    'different connection',
    { runtimeId: 'r', storedId: 'stored', owner: { ...owner, connectionId: 'other' }, interrupted: false },
    {}
  ],
  [
    'different profile',
    { runtimeId: 'r', storedId: 'stored', owner: { ...owner, profile: 'b' }, interrupted: false },
    {}
  ],
  ['interrupted', { runtimeId: 'r', storedId: 'stored', owner, interrupted: true }, {}],
  ['foreign provider', { runtimeId: 'r', storedId: 'stored', owner, interrupted: false }, { provider: 'tavily' }]
])('ignores %s instead of reading the foreground account', (_, route, patch) => {
  const read = vi.fn(async () => page()),
    dispatch = vi.fn()

  const bridge = createUniSearchEvents({ route: () => route, read, dispatch })
  bridge(notice('start', patch))
  bridge(notice('complete', patch))
  expect(read).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()
})

it.each(['interrupted', 'changed account', 'new turn'])('drops an asynchronous result after %s', async reason => {
  let route = { runtimeId: 'r', storedId: 'stored', owner, interrupted: false, turnStartedAt: 100 }
  let resolve!: (value: ReturnType<typeof page>) => void

  const read = vi.fn(
    () =>
      new Promise<ReturnType<typeof page>>(r => {
        resolve = r
      })
  )

  const dispatch = vi.fn()
  const bridge = createUniSearchEvents({ route: () => route, read, dispatch })
  bridge(notice('start'))
  bridge(notice('complete'))
  route =
    reason === 'interrupted'
      ? { ...route, interrupted: true }
      : reason === 'new turn'
        ? { ...route, turnStartedAt: 200 }
        : { ...route, owner: { ...owner, connectionId: 'other' } }
  resolve(page())
  await new Promise(r => setTimeout(r, 0))
  expect(dispatch.mock.calls.map(([e]) => e.type)).toEqual(['tool.start'])
})

it('waits for persisted data and rejects an older row with a reused call id', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({ ...page(), messages: [{ ...page().messages[0], timestamp: 90 }] })
    .mockResolvedValue(page())

  const dispatch = vi.fn(),
    wait = vi.fn(async () => {})

  const bridge = createUniSearchEvents({
    route: () => ({ runtimeId: 'r', storedId: 'stored', owner, interrupted: false }),
    read,
    dispatch,
    wait
  })

  bridge(notice('start'))
  bridge(notice('complete'))
  await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
  expect(wait).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledWith('stored', owner)
})

it('decodes marked untrusted history as data and brands only verified provider results', () => {
  const wrapped =
    '<untrusted_tool_result source="web_search">\nExternal data.\n\n' +
    JSON.stringify(result) +
    '\n</untrusted_tool_result>'

  expect(decodeWebResult(wrapped)).toEqual(result)
  expect(searchCards(wrapped)).toHaveLength(1)
  expect(webProviderLabel(wrapped)).toBe('UniSearch')
  expect(webProviderLabel({ success: true, data: { web: [] } })).toBeNull()
  expect(webProviderLabel({ data: [{ metadata: { provider: 'unicrawl' } }] })).toBe('UniCrawl')
  expect(webProviderLabel({ metadata: { provider: 'builtin_parse' } })).toBe('BuiltinCrawl')
  expect(decodeWebResult(wrapped + 'trailing instructions')).toBeNull()
})
