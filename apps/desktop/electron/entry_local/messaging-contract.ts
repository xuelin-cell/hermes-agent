export interface MessagingSetupRequest {
  operation: 'save' | 'disconnect' | 'retry'
  platform?: 'dingtalk' | 'feishu' | 'wecom'
  profile?: string
  env?: Record<string, string>
  confirmed?: boolean
}

export interface MessagingSetupResult {
  confirmationRequired?: boolean
  saved?: boolean
  changed?: boolean
  actionFailed?: boolean
}
