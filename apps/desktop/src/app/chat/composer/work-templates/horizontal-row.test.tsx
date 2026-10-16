import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { HorizontalRow } from './horizontal-row'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('只有溢出时显示箭头，滚轮在列表边界交还页面滚动', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false }))
  )

  const ui = render(
    <HorizontalRow contentKey="one" leftLabel="left" rightLabel="right">
      <button>item</button>
    </HorizontalRow>
  )

  const viewport = screen.getByText('item').parentElement!
  let left = 0
  Object.defineProperties(viewport, {
    scrollLeft: { configurable: true, get: () => left },
    clientWidth: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: 600 }
  })
  const scroll = vi.fn()
  viewport.scrollBy = scroll
  fireEvent.scroll(viewport)
  expect(screen.queryByRole('button', { name: 'left' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'right' }))
  expect(scroll.mock.calls[0][0].left).toBeGreaterThan(0)
  const inward = new WheelEvent('wheel', { deltaY: 40, cancelable: true })
  viewport.dispatchEvent(inward)
  expect(inward.defaultPrevented).toBe(true)
  left = 400
  fireEvent.scroll(viewport)
  expect(screen.queryByRole('button', { name: 'right' })).toBeNull()
  expect(screen.getByRole('button', { name: 'left' })).toBeTruthy()
  const outward = new WheelEvent('wheel', { deltaY: 40, cancelable: true })
  viewport.dispatchEvent(outward)
  expect(outward.defaultPrevented).toBe(false)
  ui.unmount()
})
