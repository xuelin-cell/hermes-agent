import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { CloudDriveMcp } from '../login/cloud-drive-mcp'
import { DRIVE_MCP_SERVER } from '../login/drive-mcp-contract'

import { prepareAllProfiles } from './prepare-all-profiles'

it('真实准备 A→B→A 的未运行助手，跳过运行中、删除及外链目录，单个失败不挡其它助手', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-profile-preparation-'))
  const app = path.join(root, 'app')
  const accounts = ['a', 'b'].map(name => path.join(root, name))
  const drives = accounts.map(home => new CloudDriveMcp({} as never, home, path.join(home, 'workspace')))
  const original = 'model: personal\nplugins:\n  enabled: [personal]\n'
  const log = vi.fn()
  const claim = vi.fn()

  try {
    fs.mkdirSync(path.join(app, 'assets', 'artifact-share-plugin'), { recursive: true })
    fs.writeFileSync(path.join(app, 'assets', 'artifact-share-plugin', 'plugin.yaml'), 'name: desktop-artifact-share\n')

    for (const home of accounts) {
      for (const name of [
        '',
        'profiles/broken',
        'profiles/busy',
        'profiles/expert',
        'profiles/deleted',
        'profiles/bad name'
      ]) {
        fs.mkdirSync(path.join(home, name), { recursive: true })
        fs.writeFileSync(path.join(home, name, 'config.yaml'), name === 'profiles/broken' ? 'model: [\n' : original)
      }

      fs.mkdirSync(path.join(home, 'profiles', 'ghost'))
      fs.mkdirSync(path.join(home, 'profiles', '.deleted'))
      fs.writeFileSync(path.join(home, 'profiles', '.deleted', 'deleted'), 'deleted\n')
    }

    fs.symlinkSync(accounts[1], path.join(accounts[0], 'profiles', 'alias'), 'junction')
    const urls: string[] = []

    for (const index of [0, 1, 0]) {
      const home = accounts[index]
      await prepareAllProfiles({
        home,
        appRoot: app,
        interrupted: { claim },
        prepareDrive: profile => drives[index].prepare(profile),
        busy: profile => profile === 'busy',
        log
      })
      const config = parse(fs.readFileSync(path.join(home, 'profiles', 'expert', 'config.yaml'), 'utf8'))
      expect(config.model).toBe('personal')
      expect(config.plugins.enabled).toEqual(['personal', 'desktop-deliverables', 'uniwork-telemetry', 'desktop-artifact-share'])
      expect(
        fs.existsSync(path.join(home, 'profiles', 'expert', 'plugins', 'desktop-artifact-share', 'plugin.yaml'))
      ).toBe(true)
      expect(drives[index].available('expert')).toBe(true)
      urls.push(config.mcp_servers[DRIVE_MCP_SERVER].url)

      for (const name of ['busy', 'deleted', 'bad name']) {
        expect(fs.readFileSync(path.join(home, 'profiles', name, 'config.yaml'), 'utf8')).toBe(original)
      }

      expect(fs.existsSync(path.join(home, 'profiles', 'ghost', 'config.yaml'))).toBe(false)
      expect(fs.readFileSync(path.join(home, 'profiles', 'broken', 'config.yaml'), 'utf8')).toBe('model: [\n')

      if (index === 0 && urls.length === 1) {
        expect(fs.readFileSync(path.join(accounts[1], 'config.yaml'), 'utf8')).toBe(original)
      }
    }

    expect(urls[0]).not.toBe(urls[1])
    expect(urls[0]).toBe(urls[2])
    expect(claim.mock.calls.map(([home]) => home)).toEqual(
      [0, 1, 0].flatMap(index => [accounts[index], path.join(accounts[index], 'profiles', 'expert')])
    )
    expect(log.mock.calls.every(([message]) => message === '[profiles] preparation failed profile=broken')).toBe(true)
  } finally {
    await Promise.all(drives.map(drive => drive.close()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
