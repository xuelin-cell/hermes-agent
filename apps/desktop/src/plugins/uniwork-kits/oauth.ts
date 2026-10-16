/** Params for `mcp.servers.oauth.start` / `poll`. Profile is the expert’s profile when set. */
export function oauthStartParams(serverKey: string, profile?: string): Record<string, unknown> {
  const params: Record<string, unknown> = { name: serverKey }

  if (profile) {
    params.profile = profile
  }

  return params
}
