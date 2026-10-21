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
  /** Experts: the subtitle under the name (e.g. 东方财富妙想). */
  profession: string
  /** What the package does, in one or two sentences. */
  description: string
  /** A few of its Chinese trigger phrases — what a user can say to use it. */
  phrases: string[]
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

/** One installed expert as the summon picker shows it. */
export interface ExpertCard {
  name: string
  profile: string
  display_name: string
  profession: string
  description: string
  init_prompt: string
  quick_prompts: string[]
  /** 宿主为这位专家写的那一条「试试这样问」（和数字员工一致）；没有时为空。 */
  try_asking: string
  tags: string[]
}

export interface ExpertDirectory {
  experts: ExpertCard[]
  /** Names, most recent first. */
  recent: string[]
}

/** The backend's own install of the bundled kits and experts (GET /bundled). */
export interface BundledStatus {
  /** This backend started an install since it came up. */
  ran: boolean
  running: boolean
  /** Package being installed right now. */
  name: string
  done: number
  total: number
  installed: number
  unchanged: number
  failed: string[]
  error: string
}
