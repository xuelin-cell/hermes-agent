import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
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
function LocationProbe({ onChange }: { onChange: (location: string) => void }) {
  const location = useLocation()
  onChange(`${location.pathname}${location.search}`)

  return null
}

async function openAttachmentMenu(developerMode = false) {
  $developerMode.set(developerMode)
  const onPickFiles = vi.fn()
  const onPickFolders = vi.fn()
  const onInsertText = vi.fn()
  let location = ''
  render(
    <MemoryRouter>
      <LocationProbe onChange={next => (location = next)} />
      <I18nProvider configClient={null} initialLocale="en">
        <ContextMenu
          onInsertText={onInsertText}
          onPickFiles={onPickFiles}
          onPickFolders={onPickFolders}
          state={state}
        />
      </I18nProvider>
    </MemoryRouter>
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Add attachments' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
  await screen.findByRole('menu')

  return { location: () => location, onInsertText, onPickFiles, onPickFolders }
}

afterEach(() => {
  cleanup()
  $developerMode.set(false)
})

it.each(['Add files', 'Add folder'])('文件入口保持可用，并能调用 %s', async label => {
  const handlers = await openAttachmentMenu()
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
    'Add files',
    'Add folder',
    'Skills',
    'Connectors'
  ])
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
  expect(label === 'Add files' ? handlers.onPickFiles : handlers.onPickFolders).toHaveBeenCalledOnce()
})

it.each([
  ['Skills', 'No installed skills'],
  ['Connectors', 'No configured connectors']
])('点击 %s 会打开对应的二级开关层', async (label, emptyState) => {
  await openAttachmentMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
  expect(await screen.findByText(emptyState)).toBeTruthy()
})

it('开发者模式保留提示词片段，关闭开发者模式后隐藏对话框', async () => {
  await openAttachmentMenu(true)
  expect(screen.getAllByRole('menuitem')).toHaveLength(5)
  fireEvent.click(screen.getByRole('menuitem', { name: /Prompt snippets/i }))
  expect(await screen.findByRole('dialog')).toBeTruthy()
  act(() => $developerMode.set(false))
  expect(screen.queryByRole('dialog')).toBeNull()
})
