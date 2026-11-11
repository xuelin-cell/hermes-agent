import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $developerMode } from '@/store/developer-mode'
import { $activeGatewayProfile } from '@/store/profile'

const api = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getSkills: vi.fn(),
  reloadMcpServers: vi.fn(),
  saveMcpServers: vi.fn(),
  setSkillEnabled: vi.fn(),
  testMcpServer: vi.fn()
}))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getHermesConfigRecord: api.getConfig,
  getSkills: api.getSkills,
  reloadMcpServers: api.reloadMcpServers,
  saveMcpServers: api.saveMcpServers,
  setSkillEnabled: api.setSkillEnabled,
  testMcpServer: api.testMcpServer
}))

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

beforeEach(() => {
  $activeGatewayProfile.set('default')
  api.getConfig.mockReset()
  api.getSkills.mockReset()
  api.reloadMcpServers.mockReset()
  api.saveMcpServers.mockReset()
  api.setSkillEnabled.mockReset()
  api.testMcpServer.mockReset()
  api.getConfig.mockResolvedValue({ mcp_servers: {} })
  api.getSkills.mockResolvedValue([])
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

it('persists multiple connector choices for future conversations without probing or reloading the current one', async () => {
  api.getConfig.mockResolvedValue({
    mcp_servers: {
      alpha: { command: 'alpha' },
      beta: { command: 'beta' }
    }
  })
  let finishFirstSave: (() => void) | undefined
  api.saveMcpServers
    .mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishFirstSave = resolve
        })
    )
    .mockResolvedValue(undefined)

  await openAttachmentMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Connectors' }))
  const alpha = await screen.findByRole('switch', { name: 'alpha' })
  const beta = screen.getByRole('switch', { name: 'beta' })

  fireEvent.click(alpha)
  await waitFor(() => expect(api.saveMcpServers).toHaveBeenCalledTimes(1))
  expect(beta.disabled).toBe(false)

  fireEvent.click(beta)
  expect(finishFirstSave).toBeDefined()
  finishFirstSave?.()

  await waitFor(() => expect(api.saveMcpServers).toHaveBeenCalledTimes(2))
  expect(api.saveMcpServers.mock.calls.at(-1)).toEqual([
    {
      alpha: { command: 'alpha', enabled: false },
      beta: { command: 'beta', enabled: false }
    },
    'default'
  ])
  expect(api.testMcpServer).not.toHaveBeenCalled()
  expect(api.reloadMcpServers).not.toHaveBeenCalled()
})

it('uses the desktop connector preference write without probing or reloading', async () => {
  const localConnectors = vi.fn(async () => ({ connectors: [{ id: 'youdao_note', connected: true }] }))
  window.hermesDesktop = {
    ...window.hermesDesktop,
    getConnectionConfig: vi.fn(async () => ({ mode: 'local' })),
    localConnectors
  }
  api.getConfig
    .mockResolvedValueOnce({ mcp_servers: { connector_youdao_note: { desktop_connector: 'youdao_note', enabled: false } } })
    .mockResolvedValueOnce({ mcp_servers: { connector_youdao_note: { desktop_connector: 'youdao_note' } } })

  await openAttachmentMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Connectors' }))
  fireEvent.click(await screen.findByRole('switch', { name: 'Youdao Note' }))

  await waitFor(() =>
    expect(localConnectors).toHaveBeenCalledWith({ operation: 'enable', profile: 'default', id: 'youdao_note' })
  )
  expect(api.getConfig).toHaveBeenCalledTimes(2)
  expect(api.saveMcpServers).not.toHaveBeenCalled()
  expect(api.testMcpServer).not.toHaveBeenCalled()
  expect(api.reloadMcpServers).not.toHaveBeenCalled()
})
