export interface MessagingSetupRequest {
  operation: 'save' | 'disconnect' | 'retry' | 'watch'
  platform?: 'dingtalk' | 'feishu' | 'wecom' | 'weixin'
  profile?: string
  env?: Record<string, string>
  confirmed?: boolean
}

export interface MessagingSetupResult {
  accepted?: boolean
  confirmationRequired?: boolean
  saved?: boolean
  changed?: boolean
  actionFailed?: boolean
}

export interface MessagingOperationStatus {
  revision: number
  phase: 'idle' | 'saving' | 'applying' | 'restarting' | 'stopping' | 'checking' | 'completed' | 'failed'
  profile?: string
  platform?: MessagingSetupRequest['platform']
  operation?: MessagingSetupRequest['operation']
  saved?: boolean
  error?: string
}
