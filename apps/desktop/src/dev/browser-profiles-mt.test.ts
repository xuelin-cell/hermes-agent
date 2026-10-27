import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesConnection } from '@/global'

import {
  agentRoster,
  connectionForProfile,
  instanceProfiles,
  profileRoutes,
  resetInstanceProfiles,
  withProfileQuery
} from './browser-profiles-mt'

const conn = { connectionId: 'local', profile: 'default', wsUrl: 'ws://x/api/ws' } as HermesConnection

afterEach(() => resetInstanceProfiles())

describe('several agents on the instance’s one serve', () => {
  it('hands out the one connection, marked shared for every profile but the primary', () => {
    expect(connectionForProfile(conn)).toBe(conn)
    expect(connectionForProfile(conn, 'default')).toBe(conn)
    expect(connectionForProfile(conn, ' ')).toBe(conn)
    expect(connectionForProfile(conn, 'uw-agent_e2e_data')).toEqual({
      ...conn,
      profile: 'uw-agent_e2e_data',
      sharedPrimary: true
    })
    expect(connectionForProfile(conn, 'mine', 'local')).toMatchObject({ profile: 'mine', sharedPrimary: true })
    expect(() => connectionForProfile(conn, 'mine', 'laptop')).toThrow('No connection with id "laptop".')
  })

  it('names the profile on hermes’ REST calls, the primary’s too, and leaves an explicit one alone', () => {
    expect(withProfileQuery('/api/config')).toBe('/api/config?profile=default')
    expect(withProfileQuery('/api/skills', 'uw-a1')).toBe('/api/skills?profile=uw-a1')
    expect(withProfileQuery('/api/fs/list?path=%2Fopt%2Fdata%20x', 'mine')).toBe(
      '/api/fs/list?path=%2Fopt%2Fdata%20x&profile=mine'
    )
    expect(withProfileQuery('/api/sessions/s1/messages?profile=bot', 'other')).toBe(
      '/api/sessions/s1/messages?profile=bot'
    )
    expect(withProfileQuery('/__mt_user/files/trash', 'uw-a1')).toBe('/__mt_user/files/trash')
  })

  it('lists the serve’s profiles for the roster and the plugin routes, asking once for both', async () => {
    const fetchJson = vi.fn(async () => ({
      profiles: [{ name: 'default' }, { name: 'uw-agent_e2e_data' }, { name: 'mine' }]
    }))

    const roster = await agentRoster(fetchJson as never)

    expect(roster.sources).toEqual([{ connectionId: 'local', kind: 'local', label: 'This device', reachable: true }])
    expect(roster.agents.map(a => [a.profile, a.handle, a.connectionKind])).toEqual([
      ['default', 'default', 'local'],
      ['uw-agent_e2e_data', 'uw-agent_e2e_data', 'local'],
      ['mine', 'mine', 'local']
    ])
    expect(await profileRoutes(fetchJson as never)).toEqual([
      { connectionId: 'local', mode: 'local', profile: 'default', targetProfile: 'default' },
      { connectionId: 'local', mode: 'local', profile: 'uw-agent_e2e_data', targetProfile: 'uw-agent_e2e_data' },
      { connectionId: 'local', mode: 'local', profile: 'mine', targetProfile: 'mine' }
    ])
    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(fetchJson).toHaveBeenCalledWith({ path: '/api/profiles' })
  })

  it('falls back to the primary alone when the serve does not answer, and asks again next time', async () => {
    const failing = vi.fn(async () => {
      throw new Error('502')
    })

    expect(await instanceProfiles(failing as never)).toEqual(['default'])
    expect(await instanceProfiles(failing as never)).toEqual(['default'])
    expect(failing).toHaveBeenCalledTimes(2)
  })
})
