import { afterEach, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

vi.mock('@hermes/plugin-sdk', () => ({ host: { navigate: vi.fn(), requestProfile: vi.fn() } }))
vi.mock('./api', () => ({ syncExpert: vi.fn(async () => ({ changes: [] })) }))

import { host } from '@hermes/plugin-sdk'
import { syncExpert } from './api'
import { adoptConnector, dismissConnectorLogin, goToConnector, offerConnectorLogin } from './connector-login'
import type { ExpertCard } from './types'

const originalBridge = window.hermesDesktop
afterEach(() => {
  dismissConnectorLogin()
  window.hermesDesktop = originalBridge
  window.location.hash = ''
  vi.clearAllMocks()
})

it('cloud expert prompts, deep links and polling use that expert without reloading an existing conversation', async () => {
  const expert = { name: 'fund-diagnostician', profile: 'fund-diagnostician', required_connector: 'eastmoney_mcp' } as ExpertCard
  window.hermesDesktop = { ...originalBridge, cloudKits: true, cloudConnectorIds: ['eastmoney_mcp'] }
  const check = vi.fn(async () => false)
  await offerConnectorLogin(expert, check)
  expect(check).toHaveBeenCalledWith('eastmoney_mcp', 'fund-diagnostician')
  window.location.hash = '#/capabilities?tab=connectors'
  const ready = vi.fn()
  const connected = vi.fn(async () => true)
  goToConnector(ready, connected)
  expect(host.navigate).toHaveBeenCalledWith('/capabilities?tab=connectors&recommended=eastmoney_mcp&connectorProfile=fund-diagnostician')
  await waitFor(() => expect(ready).toHaveBeenCalledWith(expert))
  expect(connected).toHaveBeenCalledWith('eastmoney_mcp', 'fund-diagnostician')
  await adoptConnector(expert)
  expect(syncExpert).not.toHaveBeenCalled()
  expect(host.requestProfile).not.toHaveBeenCalled()
  delete window.hermesDesktop.cloudKits
  delete window.hermesDesktop.cloudConnectorIds
  await offerConnectorLogin(expert, check)
  expect(check).toHaveBeenLastCalledWith('eastmoney_mcp')
  await adoptConnector(expert)
  expect(syncExpert).toHaveBeenCalledWith(expert.name)
})
