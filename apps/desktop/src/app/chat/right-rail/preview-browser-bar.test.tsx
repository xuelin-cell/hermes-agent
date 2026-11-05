import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PreviewBrowserBar } from './preview-browser-bar'

const baseProps = {
  canGoBack: false,
  canGoForward: false,
  consoleOpen: false,
  devToolsOpen: false,
  loading: false,
  onBack: vi.fn(),
  onForward: vi.fn(),
  onPopOut: vi.fn(),
  onReload: vi.fn(),
  onToggleConsole: vi.fn(),
  onToggleDevTools: vi.fn()
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PreviewBrowserBar', () => {
  it('隐藏网址输入框和内嵌复制按钮，加载时仍能刷新', () => {
    const rendered = render(<PreviewBrowserBar {...baseProps} loading />)

    expect(rendered.queryByRole('textbox')).toBeNull()
    expect(rendered.queryByRole('button', { name: 'Copy URL' })).toBeNull()
    fireEvent.click(rendered.getByRole('button', { name: 'Reload page' }))
    expect(baseProps.onReload).toHaveBeenCalledOnce()
  })
  it('disables back and forward when there is no history', () => {
    const rendered = render(<PreviewBrowserBar {...baseProps} />)

    expect((rendered.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true)
    expect((rendered.getByRole('button', { name: 'Forward' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it.each([
    ['Back', 'onBack'],
    ['Forward', 'onForward'],
    ['Reload page', 'onReload'],
    ['Pop out', 'onPopOut']
  ] as const)('fires %s', (label, handler) => {
    const spy = vi.fn()
    const rendered = render(<PreviewBrowserBar {...baseProps} canGoBack canGoForward {...{ [handler]: spy }} />)

    fireEvent.click(rendered.getByRole('button', { name: label }))

    expect(spy).toHaveBeenCalledOnce()
  })

  it('toggles the console and DevTools, and labels them by current state', () => {
    const onToggleConsole = vi.fn()
    const onToggleDevTools = vi.fn()

    const rendered = render(
      <PreviewBrowserBar {...baseProps} onToggleConsole={onToggleConsole} onToggleDevTools={onToggleDevTools} />
    )

    fireEvent.click(rendered.getByRole('button', { name: 'Show preview console' }))
    fireEvent.click(rendered.getByRole('button', { name: 'Open preview DevTools' }))

    expect(onToggleConsole).toHaveBeenCalledOnce()
    expect(onToggleDevTools).toHaveBeenCalledOnce()

    rendered.rerender(<PreviewBrowserBar {...baseProps} consoleOpen devToolsOpen />)

    expect(rendered.getByRole('button', { name: 'Hide preview console' }).getAttribute('aria-pressed')).toBe('true')
    expect(rendered.getByRole('button', { name: 'Hide preview DevTools' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('shows Open in browser when only the external handler is provided', () => {
    const onOpenExternal = vi.fn()

    const rendered = render(<PreviewBrowserBar {...baseProps} onOpenExternal={onOpenExternal} onPopOut={undefined} />)

    expect(rendered.getByRole('button', { name: 'Open in browser' })).toBeTruthy()
    expect(rendered.queryByRole('button', { name: 'Pop out' })).toBeNull()

    fireEvent.click(rendered.getByRole('button', { name: 'Open in browser' }))

    expect(onOpenExternal).toHaveBeenCalledOnce()
  })

  it('prefers pop-out over open-in-browser when both handlers are provided', () => {
    const rendered = render(<PreviewBrowserBar {...baseProps} onOpenExternal={vi.fn()} />)

    expect(rendered.getByRole('button', { name: 'Pop out' })).toBeTruthy()
    expect(rendered.queryByRole('button', { name: 'Open in browser' })).toBeNull()
  })

  it('shows Pop in when the window is already popped out', () => {
    const onPopIn = vi.fn()
    const rendered = render(<PreviewBrowserBar {...baseProps} onPopIn={onPopIn} onPopOut={undefined} />)

    expect(rendered.getByRole('button', { name: 'Pop in' })).toBeTruthy()
    expect(rendered.queryByRole('button', { name: 'Pop out' })).toBeNull()
    expect(rendered.queryByRole('button', { name: 'Open in browser' })).toBeNull()

    fireEvent.click(rendered.getByRole('button', { name: 'Pop in' }))

    expect(onPopIn).toHaveBeenCalledOnce()
  })
})
