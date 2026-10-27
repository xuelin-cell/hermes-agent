// desktop-mt: several agents (profiles) in the cloud's browser build.
//
// The cloud instance runs ONE `hermes serve`, and it hosts every profile of the
// user: their own agents (Bot Mode's "new bot") and the Agents the enterprise
// platform installs (deploy/hermes-mt/seed/mtent.py). That is Electron's
// "shared primary" mode, rebuilt for a page that cannot spawn backends:
//
// - every profile rides the one websocket; a connection asked for another
//   profile is the same descriptor marked `sharedPrimary`, so the gateway adds
//   `profile` to each RPC instead of dialing a second socket;
// - REST calls name their profile with `?profile=` (the primary's is `default`):
//   once the serve hosts several profiles, routes that delete or overwrite
//   profile data refuse an unnamed one (hermes_cli/web_routers/_common.py);
// - the roster and the plugin routes are the serve's own `GET /api/profiles`.

import type { DesktopAgentRoster, DesktopPluginProfileRoute, HermesConnection } from '@/global'

export const LOCAL_CONNECTION_ID = 'local'
export const LOCAL_CONNECTION_LABEL = 'This device'
export const PRIMARY_PROFILE = 'default'
const PROFILES_TTL_MS = 3000

type Fetch = <T>(request: { path: string }) => Promise<T>

/** The descriptor for `profile` on the one backend (Electron's shared primary). */
export function connectionForProfile(
  conn: HermesConnection,
  profile?: null | string,
  connectionId?: null | string
): HermesConnection {
  if (connectionId && connectionId !== LOCAL_CONNECTION_ID) {
    // gateway.ts stops retrying a connection the registry does not know
    throw new Error(`No connection with id "${connectionId}".`)
  }

  const name = String(profile ?? '').trim()

  return !name || name === PRIMARY_PROFILE ? conn : { ...conn, profile: name, sharedPrimary: true }
}

/** `path` with `?profile=` for hermes' REST API; an explicit one already there wins. */
export function withProfileQuery(path: string, profile?: null | string): string {
  if (!path.startsWith('/api/')) {
    return path // the instance's own endpoints (/__mt_user/…) know no profiles
  }

  const name = String(profile ?? '').trim() || PRIMARY_PROFILE

  if (new URL(path, 'http://hermes.local').searchParams.has('profile')) {
    return path
  }

  // appended, not re-serialized: the caller's own encoding of the other parameters stays as it was
  const [base, hash = ''] = path.split('#', 2)

  return `${base}${base.includes('?') ? '&' : '?'}profile=${encodeURIComponent(name)}${hash ? `#${hash}` : ''}`
}

let cached: { at: number; names: Promise<string[]> } | null = null

/** Profile names the serve hosts, cached briefly: the roster and the routes ask together. */
export function instanceProfiles(fetchJson: Fetch, now = Date.now()): Promise<string[]> {
  if (cached && now - cached.at < PROFILES_TTL_MS) {
    return cached.names
  }

  const names = fetchJson<{ profiles?: { name?: string }[] }>({ path: '/api/profiles' })
    .then(body => {
      const list = (body.profiles ?? []).map(p => String(p?.name ?? '').trim()).filter(Boolean)

      return list.includes(PRIMARY_PROFILE) ? list : [PRIMARY_PROFILE, ...list]
    })
    .catch(() => {
      cached = null

      return [PRIMARY_PROFILE]
    })

  cached = { at: now, names }

  return names
}

export function resetInstanceProfiles(): void {
  cached = null
}

export async function agentRoster(fetchJson: Fetch): Promise<DesktopAgentRoster> {
  const names = await instanceProfiles(fetchJson)

  return {
    agents: names.map(name => ({
      connectionId: LOCAL_CONNECTION_ID,
      connectionKind: 'local',
      connectionLabel: LOCAL_CONNECTION_LABEL,
      profile: name,
      targetProfile: name,
      handle: name
    })),
    // requestProfile('name') reads roster.sources (sdk/index.ts): an empty roster without it throws
    sources: [{ connectionId: LOCAL_CONNECTION_ID, kind: 'local', label: LOCAL_CONNECTION_LABEL, reachable: true }]
  }
}

/** Every profile on the one backend, whatever names the caller asks about: the browser's
 * profile store lists only the primary, Bot Mode lists the rest itself. */
export async function profileRoutes(fetchJson: Fetch): Promise<DesktopPluginProfileRoute[]> {
  const names = await instanceProfiles(fetchJson)

  return names.map(name => ({ connectionId: LOCAL_CONNECTION_ID, mode: 'local', profile: name, targetProfile: name }))
}
