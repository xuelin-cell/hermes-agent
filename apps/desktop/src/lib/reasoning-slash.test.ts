import { describe, expect, it } from 'vitest'

import { resolveDesktopCommand } from '@/lib/desktop-slash-commands'
import { applyReasoningSlashResult, reasoningSlashParams, reasoningSlashSetsEffort } from '@/lib/reasoning-slash'
import { $showReasoning, setShowReasoningFromConfig } from '@/store/reasoning-disclosure'

// `/reasoning hide` typed into the Desktop composer must gate Thinking blocks
// in the transcript immediately (#111761, #49664): the renderer mirrors the
// gateway's `config.set key=reasoning` answer instead of waiting for the next
// config refresh.
describe('/reasoning slash command', () => {
  it('runs as a desktop action instead of the slash worker', () => {
    expect(resolveDesktopCommand('/reasoning')?.surface.kind).toBe('action')
  })

  it('builds the gateway config.set payload, honoring the scope flags', () => {
    expect(reasoningSlashParams('hide', 's1')).toEqual({ key: 'reasoning', session_id: 's1', value: 'hide' })
    expect(reasoningSlashParams('high --global', 's1')).toEqual({
      key: 'reasoning',
      scope: 'global',
      session_id: 's1',
      value: 'high'
    })
    expect(reasoningSlashParams('   ', 's1')).toBeNull()
  })

  it('flips the Thinking gate on hide/show and leaves it alone for effort levels', () => {
    setShowReasoningFromConfig(true)
    applyReasoningSlashResult('hide')
    expect($showReasoning.get()).toBe(false)
    applyReasoningSlashResult('high')
    expect($showReasoning.get()).toBe(false)
    applyReasoningSlashResult('show')
    expect($showReasoning.get()).toBe(true)
  })

  // desktop-mt: 思考深度固定用服务器默认，/reasoning 只能切换显示。
  it('treats only the display words as allowed and anything else as an effort change', () => {
    for (const arg of ['show', 'HIDE', 'full --global', 'clamp']) {
      expect(reasoningSlashSetsEffort(reasoningSlashParams(arg, 's1')!)).toBe(false)
    }

    for (const arg of ['high', 'none', 'show high', '50']) {
      expect(reasoningSlashSetsEffort(reasoningSlashParams(arg, 's1')!)).toBe(true)
    }
  })
})
