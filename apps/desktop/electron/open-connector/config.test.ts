import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'
import { parse } from 'yaml'

import { connectorHome, prepareAgentMailConfig, prepareConnectorConfig } from './config'

it('refreshes only owned endpoints in A → B → A, preserving disabled state, filters and unrelated settings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-connector-config-'))

  try {
    for (const profile of ['A', 'B']) {
      fs.mkdirSync(path.join(root, 'profiles', profile), { recursive: true })
      fs.writeFileSync(
        path.join(root, 'profiles', profile, 'config.yaml'),
        '# preserve my comment\nmodel: user-model\nmcp_servers:\n  connector_amap:\n    desktop_connector: amap\n    url: old\n    enabled: false\n    tools: [list_apps]\n  user_server:\n    command: user-command\n'
      )
    }

    for (const profile of ['A', 'B', 'A']) {
      const home = connectorHome(root, profile)
      await prepareConnectorConfig(home, [], async id => ({
        url: `http://127.0.0.1/${profile}/${id}`,
        headers: { Authorization: profile }
      }))
      const text = fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')
      const config = parse(text)
      expect(text).toContain('# preserve my comment')
      expect(config.model).toBe('user-model')
      expect(config.mcp_servers.connector_amap).toMatchObject({
        enabled: false,
        tools: ['list_apps'],
        headers: { Authorization: profile }
      })
      expect(config.mcp_servers.user_server).toEqual({ command: 'user-command' })
    }

    expect(() => connectorHome(root, '../B')).toThrow()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('does not claim user-owned names or start a runtime for an unconfigured profile', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-connector-unowned-'))
  const file = path.join(root, 'config.yaml')
  const original = 'mcp_servers:\n  connector_amap:\n    url: https://user.example/mcp\n'
  fs.writeFileSync(file, original)

  try {
    await prepareConnectorConfig(root, ['amap'], async () => {
      throw new Error('must not launch')
    })
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('creates and enables a missing owned MCP entry for a persisted connection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-connector-create-'))
  const file = path.join(root, 'config.yaml')
  fs.writeFileSync(file, 'model: user-model\n')

  try {
    await prepareConnectorConfig(root, ['qcc_mcp'], async id => ({
      url: `http://127.0.0.1/${id}`,
      headers: { Authorization: 'Bearer runtime' },
      timeout: 600
    }))
    const config = parse(fs.readFileSync(file, 'utf8'))
    expect(config.model).toBe('user-model')
    expect(config.mcp_servers.connector_qcc_mcp).toEqual({
      url: 'http://127.0.0.1/qcc_mcp',
      headers: { Authorization: 'Bearer runtime' },
      timeout: 600,
      desktop_connector: 'qcc_mcp',
      enabled: true
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('rejects a non-map MCP section without changing the config', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-connector-invalid-'))
  const file = path.join(root, 'config.yaml')
  const original = 'mcp_servers: invalid\n'
  fs.writeFileSync(file, original)

  try {
    await expect(prepareConnectorConfig(root, ['qcc_mcp'], async () => ({}))).rejects.toThrow(
      'Cannot read connector MCP configuration'
    )
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('creates and later disables the owned hidden Agent Mail entry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-mail-config-'))
  const file = path.join(root, 'config.yaml')
  fs.writeFileSync(file, 'model: user-model\n')

  try {
    const config = async () => ({
      url: 'http://127.0.0.1/wo-mail',
      headers: { Authorization: 'Bearer runtime' },
      timeout: 600
    })

    await prepareAgentMailConfig(root, true, config)
    expect(parse(fs.readFileSync(file, 'utf8')).mcp_servers.connector_wo_mail).toEqual({
      url: 'http://127.0.0.1/wo-mail',
      headers: { Authorization: 'Bearer runtime' },
      timeout: 600,
      desktop_agent_mail: true,
      enabled: true
    })

    await prepareAgentMailConfig(root, true, config, false)
    expect(parse(fs.readFileSync(file, 'utf8')).mcp_servers.connector_wo_mail.enabled).toBe(false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
