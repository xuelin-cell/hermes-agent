import type { ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { $showReasoning } from '@/store/reasoning-disclosure'

import { searchCards } from './result'
import { SearchCardResults } from './results'

stubThreadEnvironment()
stubThreadViewportSize()
afterEach(() => {
  cleanup()
  $showReasoning.set(true)
})
/** 构造规范化卡片，验证不同种类沿同一入口展示。 */
const card = (type: string, canonical: unknown) => ({ type, raw: { _canonical: canonical } })
const stock = card('stock', { name: '示例股票', price: '123.45', change_value: '+1.00', trend: 'up' })
const result = { success: true, data: { web: [], cards: [stock] } }

it('renders all five categories, both gold styles, and ignores malformed or unknown cards', () => {
  const value = {
    success: true,
    data: {
      cards: [
        stock,
        card('weather', { location: '北京', today: { summary: '晴', temp_low: '10', temp_high: '20' }, forecast: [] }),
        card('exchangerate', { name: 'USD/CNY', quotes: [{ value: '7.1' }] }),
        card('gold', { name: '黄金', style: 'quote', quotes: [{ value: '800', unit: '元/克' }] }),
        card('gold', {
          name: '黄金',
          style: 'merchant',
          merchant_groups: [{ items: [{ brand: '测试金店', price: '810' }] }]
        }),
        card('train', {
          trains: [{ number: 'G1', from_station: '北京南', to_station: '上海虹桥', depart_time: '09:00' }]
        }),
        card('future', {}),
        { type: 'stock', raw: null },
        card('exchangerate', { name: 'broken', quotes: ['bad'] })
      ]
    }
  }

  expect(searchCards(JSON.stringify(value))).toHaveLength(6)
  render(<SearchCardResults results={[value]} />)

  for (const text of ['123.45', '北京', 'USD/CNY', '800', '测试金店', 'G1']) {
    expect(screen.getByText(text)).toBeTruthy()
  }

  expect(screen.queryByText('broken')).toBeNull()
})

it('keeps cards visible once in folded activity, expanded activity and answer-only history', () => {
  const message = {
    id: 'card-history',
    role: 'assistant',
    createdAt: new Date(),
    status: { type: 'complete', reason: 'stop' },
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read',
        toolName: 'read_file',
        args: { path: '/example' },
        argsText: '{}',
        result: { content: 'ok' }
      },
      {
        type: 'tool-call',
        toolCallId: 'search',
        toolName: 'web_search',
        args: { query: '股票' },
        argsText: '{}',
        result: JSON.stringify(result)
      },
      { type: 'text', text: '查询完成' }
    ],
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
  } as unknown as ThreadMessage

  const view = render(
    <ThreadRuntime messages={[message]}>
      <Thread />
    </ThreadRuntime>
  )

  expect(screen.getAllByText('123.45')).toHaveLength(1)
  const summary = view.container.querySelector('[data-tool-summary]')
  expect(summary).toBeTruthy()
  fireEvent.click(summary!.querySelector('button') ?? summary!.querySelector('[role="button"]') ?? summary!)
  expect(screen.getAllByText('123.45')).toHaveLength(1)
  view.unmount()
  $showReasoning.set(false)
  render(
    <ThreadRuntime messages={[message]}>
      <Thread />
    </ThreadRuntime>
  )
  expect(screen.getAllByText('123.45')).toHaveLength(1)
  expect(screen.queryByText('/example')).toBeNull()
})

it('preserves the same cards through live completion and persisted tool-result hydration', async () => {
  const { upsertToolPart, toolPartFromStoredCall, applyStoredToolResultToParts } =
    await import('@/lib/chat-messages/tool-parts')

  const live = upsertToolPart(
    [],
    { name: 'web_search', tool_id: 'search-id', args: { query: 'stock' }, result },
    'complete'
  )

  const call = toolPartFromStoredCall(
    { id: 'search-id', function: { name: 'web_search', arguments: '{"query":"stock"}' } },
    0
  )

  const stored = applyStoredToolResultToParts([call], {
    role: 'tool',
    tool_call_id: 'search-id',
    tool_name: 'web_search',
    content: JSON.stringify(result)
  } as never)

  expect(searchCards((live[0] as { result: unknown }).result)).toEqual([stock])
  expect(searchCards((stored![0] as { result: unknown }).result)).toEqual([stock])
})

it('drops malformed nested card fields while preserving valid cards and the rest of the conversation', () => {
  const invalid = [
    card('weather', { today: { summary: { invalid: true }, temp_low: '1', temp_high: '2' } }),
    card('weather', { today: { summary: '晴', temp_low: '1', temp_high: '2' }, forecast: [null] }),
    card('weather', { today: { summary: '晴', temp_low: '1', temp_high: '2' }, forecast: null }),
    card('stock', { name: 'bad', price: '1', code: { bad: true } }),
    card('exchangerate', { name: 'bad', quotes: [{ value: '1', stats: [{ label: { bad: true } }] }] }),
    card('gold', { style: 'merchant', name: 'bad', merchant_groups: [{ items: [{ brand: { bad: true } }] }] }),
    card('train', { trains: [{ number: 'G1', from_station: 'a', to_station: 'b', type: { bad: true } }] }),
    { type: 'weather', raw: { jsonData: { display_info: { day: [null] } } } },
    card('__proto__', {}),
    card('toString', {})
  ]

  expect(searchCards({ success: true, data: { cards: invalid } })).toEqual([])
  render(
    <>
      <p>模型正文保留</p>
      <SearchCardResults results={[{ success: true, data: { cards: [stock, ...invalid] } }]} />
      <p>其他工具保留</p>
    </>
  )
  expect(screen.getByText('123.45')).toBeTruthy()
  expect(screen.getByText('模型正文保留')).toBeTruthy()
  expect(screen.getByText('其他工具保留')).toBeTruthy()
})

it('keeps valid legacy weather alongside canonical results', () => {
  const legacy = {
    type: 'weather',
    raw: {
      jsonData: {
        display_info: {
          location: '兼容天气',
          day: [{ summary: '晴', number_low: '10', number_high: '20', other_week: '周五' }]
        }
      }
    }
  }

  render(<SearchCardResults results={[{ data: { cards: [legacy, stock] } }]} />)
  expect(screen.getByText('兼容天气')).toBeTruthy()
  expect(screen.getByText('123.45')).toBeTruthy()
})

it('isolates an unexpected single-card render error from other cards and answer text', async () => {
  const registry = await import('./index')
  const original = registry.getCardComponent

  const component = vi.spyOn(registry, 'getCardComponent').mockImplementation(type =>
    type === 'weather'
      ? () => {
          throw new Error('synthetic card render failure')
        }
      : original(type)
  )

  const error = vi.spyOn(console, 'error').mockImplementation(() => {})

  try {
    const weather = card('weather', { today: { summary: '晴', temp_low: '1', temp_high: '2' }, forecast: [] })
    render(
      <>
        <p>回答与其他工具保持</p>
        <SearchCardResults results={[{ data: { cards: [weather, stock] } }]} />
      </>
    )
    expect(screen.getByText('回答与其他工具保持')).toBeTruthy()
    expect(screen.getByText('123.45')).toBeTruthy()
  } finally {
    component.mockRestore()
    error.mockRestore()
  }
})
