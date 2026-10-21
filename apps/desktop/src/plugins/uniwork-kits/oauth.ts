/** 发起或轮询 MCP 授权（mcp.servers.oauth.start / poll）用的参数；授权的是专家的 MCP 时带上专家的档案名。 */
export function oauthStartParams(serverKey: string, profile?: string): Record<string, unknown> {
  const params: Record<string, unknown> = { name: serverKey }

  if (profile) {
    params.profile = profile
  }

  return params
}
