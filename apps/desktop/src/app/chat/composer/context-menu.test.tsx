import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $developerMode } from '@/store/developer-mode'

import { ContextMenu } from './context-menu'
import type { ChatBarState } from './types'

const state: ChatBarState = {
  model: { canSwitch: false, model: '', provider: '' },
  tools: { enabled: true, label: 'Add attachments' },
  voice: { enabled: false, active: false }
}

/** 通过正式加号菜单验证精简后的入口和开发者模式。 */
async function openAttachmentMenu(developerMode = false) {
  $developerMode.set(developerMode)
  const onPickFiles = vi.fn()
  const onPickFolders = vi.fn()
  const onInsertText = vi.fn()
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <ContextMenu onInsertText={onInsertText} onPickFiles={onPickFiles} onPickFolders={onPickFolders} state={state} />
    </I18nProvider>
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Add attachments' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
  await screen.findByRole('menu')

  return { onInsertText, onPickFiles, onPickFolders }
}

afterEach(() => {
  cleanup()
  $developerMode.set(false)
})

it.each(['Add files', 'Add folder'])('普通模式仅显示两个附件入口，并能调用 %s', async label => {
  const handlers = await openAttachmentMenu()
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Add files', 'Add folder'])
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
  expect(label === 'Add files' ? handlers.onPickFiles : handlers.onPickFolders).toHaveBeenCalledOnce()
})

it('开发者模式保留提示词片段，关闭开发者模式后隐藏对话框', async () => {
  await openAttachmentMenu(true)
  expect(screen.getAllByRole('menuitem')).toHaveLength(3)
  fireEvent.click(screen.getByRole('menuitem', { name: /Prompt snippets/i }))
  expect(await screen.findByRole('dialog')).toBeTruthy()
  act(() => $developerMode.set(false))
  expect(screen.queryByRole('dialog')).toBeNull()
})
