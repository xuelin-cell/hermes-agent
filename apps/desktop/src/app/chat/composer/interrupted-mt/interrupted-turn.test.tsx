import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatBarState } from '@/app/chat/composer/types'
import { PRIMARY_SESSION_VIEW, SessionViewProvider } from '@/app/chat/session-view'
import { I18nProvider } from '@/i18n'

import { ComposerControls } from '../controls'

import {
  $interruptedTurns,
  CONTINUE_PREFIX,
  continueNote,
  RESUME_WINDOW_MS,
  useInterruptedTurn
} from './interrupted-turn'
import { useInterruptedComposer } from './use-interrupted-composer'

vi.mock('../model-pill', () => ({ ModelPill: () => null }))

const NOW = 1_800_000_000_000
const TURN = { detectedAt: NOW, prompt: '整理季度报告', sessionId: 'stored-1' }

const state: ChatBarState = {
  model: { canSwitch: false, model: '', provider: '' },
  tools: { enabled: false, label: '' },
  voice: { active: false, enabled: false }
}

let bridge: { dismiss: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  bridge = { dismiss: vi.fn(async () => {}), list: vi.fn(async () => [TURN]) }
  window.hermesDesktop = { interruptedTurns: bridge } as never
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  $interruptedTurns.set({})
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

/** 只关心发送键位置的最小输入栏控件。 */
function renderControls(props: Partial<React.ComponentProps<typeof ComposerControls>>) {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ComposerControls
        autoSpeak={false}
        busy={false}
        busyAction="stop"
        canSubmit={false}
        conversation={{
          active: false,
          level: 0,
          muted: false,
          onEnd: vi.fn(),
          onStart: vi.fn(),
          onStopTurn: vi.fn(),
          onToggleMute: vi.fn(),
          status: 'idle'
        }}
        disabled={false}
        hasComposerPayload={false}
        onDictate={vi.fn()}
        onQueue={vi.fn()}
        onStop={vi.fn()}
        onToggleAutoSpeak={vi.fn()}
        state={state}
        voiceStatus="idle"
        {...props}
      />
    </I18nProvider>
  )
}

describe('发送键位置', () => {
  it('输入框空着时显示 ▶，点它续跑', () => {
    const onContinue = vi.fn()
    renderControls({ onContinueInterrupted: onContinue })

    fireEvent.click(screen.getByTestId('continue-interrupted'))
    expect(onContinue).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('继续上次中断的回答')).toBeTruthy()
  })

  it('一打字就变回发送键；正在回答时仍是停止键', () => {
    const { unmount } = renderControls({ canSubmit: true, hasComposerPayload: true, onContinueInterrupted: vi.fn() })
    expect(screen.queryByTestId('continue-interrupted')).toBeNull()
    expect(screen.getByLabelText('发送')).toBeTruthy()
    unmount()

    renderControls({ busy: true, canSubmit: true, onContinueInterrupted: vi.fn() })
    expect(screen.queryByTestId('continue-interrupted')).toBeNull()
  })

  it('没有中断记录时与原来一样', () => {
    renderControls({})
    expect(screen.queryByTestId('continue-interrupted')).toBeNull()
  })
})

describe('中断记录', () => {
  it('连上后端后取到记录；15 分钟一到自动消失', async () => {
    const { result } = renderHook(() => useInterruptedTurn('stored-1', true, false))
    await act(async () => {})
    expect(result.current).toEqual(TURN)

    await act(async () => {
      vi.advanceTimersByTime(RESUME_WINDOW_MS + 100)
    })
    expect(result.current).toBeNull()
  })

  it('别的会话不显示；未连上后端时不查询', async () => {
    const other = renderHook(() => useInterruptedTurn('stored-2', true, false))
    await act(async () => {})
    expect(other.result.current).toBeNull()
    other.unmount()

    bridge.list.mockClear()
    renderHook(() => useInterruptedTurn('stored-1', false, false))
    await act(async () => {})
    expect(bridge.list).not.toHaveBeenCalled()
  })

  it('这段对话开始新的一轮（点 ▶ 或发新消息）就作废', async () => {
    const { rerender, result } = renderHook(({ busy }) => useInterruptedTurn('stored-1', true, busy), {
      initialProps: { busy: false }
    })

    await act(async () => {})
    rerender({ busy: true })

    expect(result.current).toBeNull()
    expect(bridge.dismiss).toHaveBeenCalledWith('stored-1')
  })
})

describe('点 ▶ 续跑', () => {
  it('以隐藏消息发出与 Hermes 原来相同的续跑说明，带上原来的请求', async () => {
    const onSubmit = vi.fn(async () => true)
    const view = { ...PRIMARY_SESSION_VIEW, $storedId: atom<null | string>('stored-1') }

    const { result } = renderHook(() => useInterruptedComposer({ busy: false, connected: true, onSubmit }), {
      wrapper: ({ children }) => (
        <I18nProvider configClient={null} initialLocale="zh">
          <SessionViewProvider value={view}>{children}</SessionViewProvider>
        </I18nProvider>
      )
    })

    await act(async () => {})

    expect(result.current.placeholder).toBe('上次回答因程序退出被中断，点击 ▶ 继续，或直接输入新内容')
    await act(async () => result.current.onContinue?.())

    expect(onSubmit).toHaveBeenCalledWith(continueNote('整理季度报告'), { displayKind: 'hidden' })
    expect(continueNote('x').startsWith(CONTINUE_PREFIX)).toBe(true)
    expect(bridge.dismiss).toHaveBeenCalledWith('stored-1')
    expect(result.current.onContinue).toBeUndefined()
  })
})
