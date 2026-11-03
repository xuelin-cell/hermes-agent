import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'

vi.mock('./connectors-tab', () => ({
  /** 用可编辑草稿验证标签切换保持原生页面实例，后端行为由原生页面测试覆盖。 */
  McpConnectorsTab: ({ profile }: { profile: string }) => {
    const [draft, setDraft] = useState('')

    return (
      <label>
        {typeof profile === 'string' ? profile : 'work'}
        <input aria-label="MCP draft" onChange={event => setDraft(event.target.value)} value={draft} />
      </label>
    )
  }
}))

import { ConnectorsPage } from './connectors-page'
import { CLOUD_CONNECTOR_IDS } from '../../../../services/open-connector/cloud/contract'

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.hermesBrowser
  delete window.hermesDesktop.cloudConnectorIds
})
const localConnectors = vi.fn()
beforeEach(() => {
  localConnectors.mockReset()
  localConnectors.mockImplementation(async input => ({
    connectors: [{ id: 'qq_mail', connected: input.operation === 'connect' }]
  }))
  window.hermesDesktop = { ...window.hermesDesktop, localConnectors }
})

/** 展示当前路由以核对 MCP 入口没有丢失 Profile 之外的查询参数。 */
function RouteLocation() {
  return <output data-testid="location">{useLocation().search}</output>
}

/** 使用真实目录、弹窗与路由，不访问账号、凭据或远程连接器。 */
function renderPage(route = '/capabilities?tab=connectors', searchContainer?: HTMLDivElement, profile = 'work') {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter initialEntries={[route]}>
        <ConnectorsPage
          gateway={null}
          profile={{ connectionId: 'local', profile }}
          searchContainer={searchContainer}
        />
        <RouteLocation />
      </MemoryRouter>
    </I18nProvider>
  )
}

it('云端连接器复用凭据表单，iFinD 提交登记的客户端而不沿用桌面回调', async () => {
  document.documentElement.dataset.hermesBrowser = 'production'
  window.hermesDesktop.cloudConnectorIds = CLOUD_CONNECTOR_IDS
  const enabled = new Set<string>()
  localConnectors.mockImplementation(async input => {
    if (input.operation === 'connect') enabled.add(input.id)
    return { connectors: CLOUD_CONNECTOR_IDS.map(id => ({ id, connected: enabled.has(id), configured: enabled.has(id), enabled: enabled.has(id) })) }
  })
  renderPage('/capabilities?tab=connectors', undefined, 'default')
  await waitFor(() => expect(localConnectors).toHaveBeenCalledWith({ operation: 'list', profile: 'default' }))
  const examples = [
    { id: 'youdao_note', name: '有道云笔记', values: { apiKey: 'note-key' }, labels: ['API Key'] },
    { id: 'wps_mcp', name: 'WPS', values: { apiKey: 'apik:test' }, labels: ['API Key'] },
    { id: 'wecom_bot', name: '企业微信', values: { botId: 'bot', secret: 'secret' }, labels: ['Bot ID', 'Secret'] },
    { id: 'ima', name: '腾讯 ima 知识库', values: { clientId: 'client', apiKey: 'ima-key' }, labels: ['Client ID', 'API Key'] },
    { id: 'qq_mail', name: 'QQ 邮箱', values: { email: 'alice@qq.com', authorizationCode: 'alicexxxxxxxxxxx' }, labels: ['邮箱地址', '授权码'] },
    { id: 'netease_mail', name: '网易邮箱', values: { email: 'alice@163.com', authorizationCode: 'alicexxxxxxxxxxx' }, labels: ['邮箱地址', '授权码'] },
    { id: 'aminer', name: 'AMiner学术', values: { apiKey: 'academic-key' }, labels: ['API Key'] },
    { id: 'ifind_mcp', name: '同花顺 iFinD', values: { clientId: 'cloud-client' }, labels: ['Client ID'] }
  ]
  for (const item of examples) {
    fireEvent.click(screen.getByRole('button', { name: '查看' + item.name }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '连接' }))
    for (const [index, value] of Object.values(item.values).entries()) {
      fireEvent.change(within(dialog).getByLabelText(item.labels[index]), { target: { value } })
    }
    if (item.id === 'ifind_mcp') expect(within(dialog).getByText(/__entry\/connectors\/ifind_mcp\/oauth\/callback/)).toBeTruthy()
    fireEvent.submit(within(dialog).getByRole('form'))
    await waitFor(() => expect(localConnectors).toHaveBeenCalledWith({ operation: item.id === 'ifind_mcp' ? 'authorize' : 'connect', profile: 'default', id: item.id, values: item.values }))
    expect(localConnectors.mock.calls.some(([input]) => input.operation.startsWith('qr.'))).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  }
})

it('云端只开放已接入渠道，停用保留授权并可重新启用', async () => {
  document.documentElement.dataset.hermesBrowser = 'production'
  window.hermesDesktop.cloudConnectorIds = ['amap']
  let enabled = false
  localConnectors.mockImplementation(async input => {
    if (input.operation === 'enable') enabled = true
    if (input.operation === 'disable') { enabled = false; throw new Error('持久化未确认') }
    return { connectors: [{ id: 'amap', configured: true, enabled, connected: enabled }] }
  })
  renderPage('/capabilities?tab=connectors', undefined, 'default')
  await waitFor(() => expect(localConnectors).toHaveBeenCalledWith({ operation: 'list', profile: 'default' }))
  expect(screen.getAllByRole('button', { name: /^查看/ })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: /^查看.*高德/ }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('status').textContent).toContain('禁用')
  fireEvent.click(within(dialog).getByRole('button', { name: '启用' }))
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '禁用' })).toBeTruthy())
  fireEvent.click(within(dialog).getByRole('button', { name: '禁用' }))
  await waitFor(() => expect(within(dialog).getByText('持久化未确认')).toBeTruthy())
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '启用' })).toBeTruthy())
  expect(localConnectors).toHaveBeenCalledWith({ operation: 'disable', profile: 'default', id: 'amap' })
  expect(localConnectors.mock.calls.filter(([input]) => input.operation === 'disable')).toHaveLength(1)
  expect(localConnectors).toHaveBeenCalledWith({ operation: 'save', profile: 'default', id: 'amap' })
})

it('卡片打开参考详情；加号独立进入凭据表单，服务确认后才展示已连接', async () => {
  renderPage()
  expect(screen.getByRole('tab', { name: '推荐' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getAllByRole('button', { name: /^查看/ })).toHaveLength(11)
  const search = screen.getByRole('textbox', { name: '搜索连接器' })
  fireEvent.change(search, { target: { value: 'Tencent' } })
  expect(screen.getAllByRole('button', { name: /^查看/ })).toHaveLength(1)
  fireEvent.keyDown(screen.getByRole('button', { name: '查看QQ 邮箱' }), { key: 'Enter' })
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('heading', { name: '连接 QQ 邮箱' })).toBeTruthy()
  expect(within(dialog).getByText('试试这样用')).toBeTruthy()
  expect(
    within(dialog)
      .getAllByRole('button')
      .filter(button => button.textContent?.includes('「QQ 邮箱」'))
  ).toHaveLength(5)
  expect(within(dialog).queryByRole('textbox')).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '连接 QQ 邮箱' }) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: '连接 QQ 邮箱' }))
  expect(screen.getByText('填写连接信息')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'demo@qq.com' } })
  fireEvent.change(screen.getByLabelText('授权码'), { target: { value: 'test-only-authorization' } })
  fireEvent.submit(screen.getByLabelText('邮箱地址').closest('form')!)
  await waitFor(() =>
    expect(localConnectors).toHaveBeenCalledWith({
      operation: 'connect',
      profile: 'work',
      id: 'qq_mail',
      values: { email: 'demo@qq.com', authorizationCode: 'test-only-authorization' }
    })
  )
  await screen.findByText('已就绪，可在新聊天中使用；现有会话保持原工具集。')
  expect(screen.queryByLabelText('授权码')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect((await screen.findByRole('button', { name: 'QQ 邮箱 · 已连接' })).textContent).toContain('已连接')
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

it('标题栏搜索在切换标签时保留占位与输入，MCP 页退出交互和无障碍树', () => {
  const header = window.document.createElement('div')
  window.document.body.append(header)
  renderPage(undefined, header)
  const search = screen.getByRole('textbox', { name: '搜索连接器' })
  fireEvent.change(search, { target: { value: 'Tencent' } })
  expect(header.contains(search)).toBe(true)
  const slot = search.closest('.mt-connectors-search-slot')!
  fireEvent.click(screen.getByRole('tab', { name: 'MCP' }))
  expect(slot.isConnected).toBe(true)
  expect(slot.getAttribute('aria-hidden')).toBe('true')
  expect(slot.hasAttribute('inert')).toBe(true)
  expect(screen.queryByRole('textbox', { name: '搜索连接器' })).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: '推荐' }))
  expect(screen.getByRole('textbox', { name: '搜索连接器' })).toBe(search)
  expect((search as HTMLInputElement).value).toBe('Tencent')
  expect(slot.hasAttribute('inert')).toBe(false)
  cleanup()
  header.remove()
})
