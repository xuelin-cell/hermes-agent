import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { mainComposerScope } from '@/store/composer'

import { ChatBar } from '../index'
import { RICH_INPUT_SLOT } from '../rich-editor'
import type { ChatBarProps, ChatBarState } from '../types'

import { loadWelcomeCatalog } from './catalog-store'
import fixture from './catalog.zh-CN.json'

vi.mock('../model-mt/model-meta', () => ({
  useComposerModelMeta: () => ({ rows: [], find: () => undefined, loading: false, error: false })
}))

afterEach(() => {
  cleanup()
  mainComposerScope.clear()
  vi.unstubAllGlobals()
})

const state: ChatBarState = {
  model: { canSwitch: false, model: '', provider: '' },
  tools: { enabled: false, label: '' }, voice: { enabled: false, active: false }
}

function Harness({ onSubmit, scope }: { onSubmit: ChatBarProps['onSubmit']; scope?: string }) {
  const runtime = useExternalStoreRuntime({
    convertMessage: (message: ThreadMessageLike) => message, isRunning: false,
    messages: [] as ThreadMessageLike[], onNew: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <ChatBar busy={false} disabled={false} gateway={null} onCancel={() => {}}
            onSubmit={onSubmit} queueSessionKey={scope} showWelcomeTemplates state={state} />
        </I18nProvider>
      </MemoryRouter>
    </AssistantRuntimeProvider>
  )
}

it('the real composer carries the selected catalog ID at send, clears it on dismissal and never borrows another draft tag', async () => {
  const catalog = structuredClone(fixture)
  const category = catalog.modules[0].tags.find(tag => tag.name === '帮我写作')!
  category.id = 'server-writing-ABC'
  vi.stubGlobal('hermesDesktop', { getWelcomeCatalog: vi.fn(async () => catalog) })
  await loadWelcomeCatalog('zh-CN', true)
  const onSubmit = vi.fn<ChatBarProps['onSubmit']>(async () => true)
  const ui = render(<Harness onSubmit={onSubmit} />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: category.name })))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: category.templates[0].name })))
  expect(onSubmit).not.toHaveBeenCalled()
  await act(async () => fireEvent.submit(ui.container.querySelector('form')!))
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  expect(onSubmit.mock.calls[0]).toEqual([category.templates[0].prompt, expect.objectContaining({
    skillTag: { id: category.id, name: category.name }
  })])

  const sendText = async () => {
    const editor = ui.container.querySelector<HTMLElement>(`[data-slot="${RICH_INPUT_SLOT}"]`)!
    await act(async () => {
      editor.textContent = 'plain message'
      fireEvent.input(editor)
      fireEvent.submit(ui.container.querySelector('form')!)
    })
  }

  await act(async () => fireEvent.click(screen.getByRole('button', { name: '取消所选分类' })))
  await sendText()
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
  expect(onSubmit.mock.calls[1][1]).not.toHaveProperty('skillTag')

  await act(async () => fireEvent.click(screen.getByRole('button', { name: category.name })))
  ui.rerender(<Harness onSubmit={onSubmit} scope="different-draft" />)
  await sendText()
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(3))
  expect(onSubmit.mock.calls[2][1]).not.toHaveProperty('skillTag')
})
