export interface UserField {
  key: string
  env: string
  title: string
  sensitive: boolean
  required: boolean
  default: string | null
}

export interface OAuthServer {
  key: string
}

export interface KitRow {
  name: string
  kind: string
  display_name: string
  version: string
  enabled: boolean | null
  profile: string
  self: boolean
  market_id: string
  skill_count: number
  agent_count: number
  mcp_count: number
  user_config: UserField[]
  missing_secrets: string[]
  oauth_servers: OAuthServer[]
  pending_triggers: number
  unverified_triggers: number
}

export interface Catalog {
  plugins: KitRow[]
}

export interface JobView {
  id: string
  running: boolean
  exit_code: number | null
  tail: string
}
