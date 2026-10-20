export const CAPTCHA_CHANNEL = 'hermes-login:captcha'
export const SEND_SMS_CHANNEL = 'hermes-login:send-sms'
export const LOGIN_CHANNEL = 'hermes-login:login'
export const RESTORE_CHANNEL = 'hermes-login:restore'
export const PLAN_CHANNEL = 'hermes-login:plan'

export interface LoginRequest {
  phone: string
  smsCode: string
}

export interface CloudDriveMutationProgress {
  id: string
  phase: 'verifying'
}

export interface CloudDriveRequest {
  requestId?: string
  route: string
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: Record<string, unknown>
}

export interface CloudDriveFailure {
  protocol: 'uniwork.drive-result.v1'
  ok: false
  status: 'failed' | 'partial_success' | 'outcome_unknown'
  code: string
}

export interface CloudDriveArtifactSource {
  sessionId: string
  profile: string
  connectionId?: string
  value: string
}

export type CloudDriveTransferRequest =
  | { id: string; operation: 'upload'; parentAssetId: string; artifact?: CloudDriveArtifactSource }
  | { id: string; operation: 'download' | 'preview'; assetId: string; name: string; size?: number | null }
  | { id: string; operation: 'download-many'; assets: Array<{ assetId: string; name: string; size?: number | null }> }

export interface CloudDriveTransferProgress {
  id: string
  completed: number
  total: number | null
  phase?: 'converting' | 'verifying'
  fileIndex?: number
  fileCount?: number
  name?: string
  fileStatus?: 'succeeded' | 'cancelled'
}

export interface CloudDriveTransferFileResult {
  index: number
  name: string
  status: 'succeeded' | 'cancelled' | 'failed' | 'partial_success' | 'outcome_unknown' | 'not_started'
  code?: string
}

export type CloudDriveTransferResult = (
  | CloudDriveFailure
  | { status: 'cancelled' }
  | { status: 'succeeded'; name: string; preview?: { path: string; kind: 'file' } }
) & { files?: CloudDriveTransferFileResult[] }

/** 主进程和页面共用读操作分类，POST 的查询接口不应被当作写入。 */
export function isCloudDriveReadOperation(input: CloudDriveRequest): boolean {
  return (
    (input.method ?? 'GET') === 'GET' ||
    (input.method === 'POST' &&
      ['/assets/download', '/assets/search', '/unicom/FileDetails', '/unicom/QueryRecycleData'].includes(
        input.route.split('?')[0]
      )) ||
    (input.method === 'DELETE' && /^\/assets\/search\/[a-f0-9]{32}$/.test(input.route))
  )
}

export interface LoginAccount {
  maskedPhone: string
  expiresAt: number
  /** 仅展示已确认的套餐鉴权拒绝，不将其当作身份到期。 */
  planAuthRejected?: true
}

export type LoginResult = { ok: true; account: LoginAccount } | { ok: false }

export interface PlanModel {
  name: string
  isDefault: boolean
}

export type PlanResult =
  { status: 'available'; models: PlanModel[] } | { status: 'empty' } | { status: 'failed'; reason?: 'auth' }

export interface SmsRequest {
  phone: string
  captchaCode: string
  captchaId: string
}

export type SmsResult =
  | { ok: true; retryAt: number }
  | { ok: false; error: 'invalid' | 'busy' | 'failed' }
  | { ok: false; error: 'limited'; retryAt: number }

export interface LoginCaptcha {
  captchaId: string
  imageDataUrl: string
}

export type CaptchaResult = { ok: true; captcha: LoginCaptcha } | { ok: false }

export interface DesktopLoginBridge {
  /** 读取主进程保管的完整记录，仅返回未到期账号的脱敏展示信息。 */
  restore(): Promise<LoginResult>
  /** 套餐独立查询，只返回名称与默认标记，不返回模型 Key 或地址。 */
  plan(): Promise<PlanResult>
  /** 请求固定 MaaS 接口，不接受页面提供的地址或请求参数。 */
  captcha(): Promise<CaptchaResult>
  /** 提交短信所需字段，主进程负责校验、发送与频率限制。 */
  sendSms(input: SmsRequest): Promise<SmsResult>
  /** 短信登录只返回脱敏账号；UID 和 token 始终由主进程保管。 */
  login(input: LoginRequest): Promise<LoginResult>
}

declare global {
  interface Window {
    hermesLogin?: DesktopLoginBridge
  }
}
