import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { asrPcm16 } from '@/lib/uniwork-asr-audio'

import { useUniworkAsr } from './use-uniwork-asr'

vi.mock('@/store/notifications', () => ({ notifyError: vi.fn() }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 用受控采集设备和窄桥接检查真实 Hook，不替换草稿回填逻辑。 */
function fixture() {
  const track = { stop: vi.fn() }
  const permission = vi.fn().mockResolvedValue({ getTracks: () => [track] })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: permission } })
  const node = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }

  const context = {
    sampleRate: 48000,
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createMediaStreamSource: () => ({ ...node }),
    createScriptProcessor: () => node,
    destination: {}
  }

  /** 模拟可释放的 AudioContext，保留实际采样转换。 */
  class AudioContextFixture {
    constructor() {
      return context as unknown as AudioContextFixture
    }
  }
  vi.stubGlobal('AudioContext', AudioContextFixture)

  const bridge = {
    start: vi.fn().mockResolvedValue('session-1'),
    audio: vi.fn().mockResolvedValue(undefined),
    poll: vi.fn().mockResolvedValue({ transcripts: [{ text: '你好', final: false }], closed: false, failed: false }),
    stop: vi.fn().mockResolvedValue({ transcripts: [{ text: '你好。', final: true }], closed: true, failed: false }),
    cancel: vi.fn().mockResolvedValue(undefined)
  }

  vi.stubGlobal('hermesDesktop', { uniworkAsr: bridge })

  return { track, permission, context, bridge }
}

it('16k PCM及流式结果正确，停止后保留尾句并释放麦克风', async () => {
  const f = fixture()
  const replaceText = vi.fn()

  const { result } = renderHook(() =>
    useUniworkAsr({ scope: 'a', disabled: false, language: 'zh', readText: () => '原文：', replaceText })
  )

  act(() => result.current.toggle())
  await waitFor(() => expect(result.current.status).toBe('recording'))
  await waitFor(() => expect(replaceText).toHaveBeenCalledWith('原文：你好'))
  expect([...asrPcm16(new Float32Array([-1, 0, 1]), 16000)]).toEqual([0, 128, 0, 0, 255, 127])
  expect(asrPcm16(new Float32Array(4800), 48000)).toHaveLength(3200)
  act(() => result.current.toggle())
  await waitFor(() => expect(result.current.status).toBe('idle'))
  expect(replaceText).toHaveBeenLastCalledWith('原文：你好。')
  expect(f.track.stop).toHaveBeenCalledOnce()
  expect(f.context.close).toHaveBeenCalledOnce()
  expect(f.bridge.stop).toHaveBeenCalledWith('session-1')
})

it('切换会话取消连接，迟到的麦克风权限不会写入新草稿', async () => {
  const f = fixture()
  let grant: (stream: unknown) => void = () => undefined
  f.permission.mockImplementation(
    () =>
      new Promise(resolve => {
        grant = resolve
      })
  )
  const replaceText = vi.fn()

  const { result, rerender } = renderHook(
    ({ scope }) => useUniworkAsr({ scope, disabled: false, language: 'zh', readText: () => '旧草稿', replaceText }),
    { initialProps: { scope: 'a' } }
  )

  act(() => result.current.toggle())
  expect(result.current.status).toBe('connecting')
  rerender({ scope: 'b' })
  await act(async () => {
    grant({ getTracks: () => [f.track] })
  })
  expect(f.track.stop).toHaveBeenCalledOnce()
  expect(f.bridge.start).not.toHaveBeenCalled()
  expect(replaceText).not.toHaveBeenCalled()
  expect(result.current.status).toBe('idle')
})
