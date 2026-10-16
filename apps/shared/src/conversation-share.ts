export interface ConversationShareRequest {
  sessionId: string
  scope: 'session' | 'response'
  responseRowId?: number
  includeProcess?: boolean
  locale?: string
  theme?: 'light' | 'dark'
}

export interface ConversationShareOwner {
  connectionId?: string
  profile?: string
}

export interface ConversationShareBlock {
  type: 'markdown' | 'reasoning' | 'tool'
  text?: string
  name?: string
}

export interface ConversationShareDocument {
  schemaVersion: 1
  snapshotId: string
  scope: 'session' | 'response'
  responseId?: string
  title: string
  locale: string
  theme: 'light' | 'dark'
  rendererVersion: number
  assets?: Array<{ reference: string; path: string; hash: string }>
  messages: Array<{ role: 'user' | 'assistant'; blocks: ConversationShareBlock[] }>
}

export interface ConversationSnapshot {
  document: ConversationShareDocument
  revision: string
  sessionId: string
}

export interface ConversationShareRecord {
  key: string
  shareId: string
  snapshotId: string
  scope: 'session' | 'response'
  title: string
  createdAt: string
  state: 'pending' | 'published' | 'revoked'
  url?: string
  owner: ConversationShareOwner
  sessionId: string
}

export interface PreparedConversationShare {
  ticket: string
  document: ConversationShareDocument
}

export interface ConversationShareApi {
  prepare: (owner: ConversationShareOwner, request: ConversationShareRequest) => Promise<PreparedConversationShare>
  publish: (ticket: string, html: string) => Promise<ConversationShareRecord>
  image: (ticket: string, reference: string) => Promise<string>
  cancel: (ticket: string) => Promise<void>
  list: (owner: ConversationShareOwner, sessionId: string) => Promise<ConversationShareRecord[]>
  revoke: (key: string) => Promise<void>
}
