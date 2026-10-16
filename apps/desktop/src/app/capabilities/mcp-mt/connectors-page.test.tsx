import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'

vi.mock('./connectors-tab', () => ({
  /** 用可编辑草稿验证标签切换保持原生页面实例，后端行为由原生页面测试覆盖。 */
  McpConnectorsTab: ({ profile }: { profile: string }) => {
    const [draft, setDraft] = useState('')

    return (
      <label>
        {profile}
        <input aria-label="MCP draft" onChange={event => setDraft(event.target.value)} value={draft} />
      </label>
    )
  }
}))

import { ConnectorsPage } from './connectors-page'

afterEach(cleanup)

/** 展示当前路由以核对 MCP 入口没有丢失 Profile 之外的查询参数。 */
function RouteLocation() {
  return <output data-testid="location">{useLocation().search}</output>
}

/** 使用真实目录、弹窗与路由，不访问账号、凭据或远程连接器。 */
function renderPage(route = '/capabilities?tab=connectors') {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter initialEntries={[route]}>
        <ConnectorsPage gateway={null} profile="work" />
        <RouteLocation />
      </MemoryRouter>
    </I18nProvider>
  )
}

it('搜索真实目录并展示尚未接入的详情，不收集凭据或伪造连接成功', () => {
  renderPage()
  expect(screen.getByRole('tab', { name: '推荐' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getAllByRole('button', { name: /^查看/ })).toHaveLength(11)
  const search = screen.getByRole('textbox', { name: '搜索连接器' })
  fireEvent.change(search, { target: { value: 'Tencent' } })
  expect(screen.getAllByRole('button', { name: /^查看/ })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '查看QQ 邮箱' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('暂未开放连接')).toBeTruthy()
  expect(within(dialog).queryByRole('textbox')).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
  fireEvent.change(search, { target: { value: 'no-such-provider' } })
  expect(screen.getByText('没有匹配的连接器')).toBeTruthy()
})

it('MCP 深链直接打开原生管理，键盘切换标签后保留未保存草稿与路由范围', () => {
  renderPage('/capabilities?tab=connectors&server=alpha&scope=work')
  const mcpTab = screen.getByRole('tab', { name: 'MCP' })
  expect(mcpTab.getAttribute('aria-selected')).toBe('true')
  fireEvent.change(screen.getByRole('textbox', { name: 'MCP draft' }), { target: { value: 'unsaved config' } })
  fireEvent.keyDown(mcpTab, { key: 'ArrowLeft' })
  expect(screen.getByRole('tab', { name: '推荐' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.queryByRole('textbox', { name: 'MCP draft' })).toBeNull()
  fireEvent.keyDown(screen.getByRole('tab', { name: '推荐' }), { key: 'ArrowRight' })
  expect((screen.getByRole('textbox', { name: 'MCP draft' }) as HTMLInputElement).value).toBe('unsaved config')
  expect(screen.getByTestId('location').textContent).toContain('scope=work')
  expect(screen.getByTestId('location').textContent).toContain('connectorView=mcp')
})
