import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it } from 'vitest'
import { parse } from 'yaml'

import { DRIVE_MCP_SERVER } from '../login/drive-mcp-contract'

import { prepareDriveMcpConfig } from './drive-mcp-config'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-drive-config-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

it('仅维护内置云盘条目，保留用户设置、开关与过滤，账号密钥不进入配置', () => {
  const file = path.join(home, 'config.yaml')
  fs.writeFileSync(file, '# 用户说明\nmodel: {provider: personal}\nmcp_servers:\n  custom: {command: local-tool}\n')
  expect(prepareDriveMcpConfig(home, 'default', 'http://127.0.0.1:1234/mcp', 'short-lived-capability')).toBe(true)
  const first = parse(fs.readFileSync(file, 'utf8'))
  expect(first.model).toEqual({ provider: 'personal' })
  expect(first.mcp_servers.custom).toEqual({ command: 'local-tool' })
  expect(first.mcp_servers[DRIVE_MCP_SERVER]).toMatchObject({
    url: 'http://127.0.0.1:1234/mcp',
    headers: { Authorization: 'Bearer short-lived-capability' }
  })

  const text = fs
    .readFileSync(file, 'utf8')
    .replace('    timeout: 600', '    timeout: 600\n    enabled: false\n    tools: {exclude: [download]}')

  fs.writeFileSync(file, text)
  expect(prepareDriveMcpConfig(home, 'default', 'http://127.0.0.1:1235/mcp', 'next-run-capability')).toBe(false)
  const next = parse(fs.readFileSync(file, 'utf8')).mcp_servers[DRIVE_MCP_SERVER]
  expect(next).toMatchObject({ enabled: false, tools: { exclude: ['download'] }, url: 'http://127.0.0.1:1235/mcp' })
  expect(fs.readFileSync(file, 'utf8')).toContain('# 用户说明')

  if (process.platform !== 'win32') {
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  }
})

it('同名个人服务、共享 YAML 与无效配置保持原文，不认领或重写', () => {
  const file = path.join(home, 'config.yaml')

  for (const content of [
    'mcp_servers: [broken',
    'mcp_servers: {UniWork-Drive: {url: https://personal.invalid/mcp}}\n',
    'common: &all {}\nmcp_servers: *all\n'
  ]) {
    fs.writeFileSync(file, content)
    expect(prepareDriveMcpConfig(home, 'default', 'http://127.0.0.1:1234/mcp', 'capability')).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(content)
  }
})

it('命名 Profile 独立配置，拒绝越界目录和符号链接', () => {
  const profile = path.join(home, 'profiles', 'work')
  fs.mkdirSync(profile, { recursive: true })
  expect(prepareDriveMcpConfig(home, 'work', 'http://127.0.0.1:1234/mcp', 'capability')).toBe(true)
  expect(fs.existsSync(path.join(profile, 'config.yaml'))).toBe(true)
  expect(fs.existsSync(path.join(home, 'config.yaml'))).toBe(false)
  expect(prepareDriveMcpConfig(home, '../work', 'http://127.0.0.1:1234/mcp', 'capability')).toBe(false)
  expect(prepareDriveMcpConfig(home, 'missing', 'http://127.0.0.1:1234/mcp', 'capability')).toBe(false)
  fs.symlinkSync(profile, path.join(home, 'profiles', 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(prepareDriveMcpConfig(home, 'alias', 'http://127.0.0.1:1234/mcp', 'capability')).toBe(false)
})
