import { hermesApi, profileScoped } from './client'

// 微信扫码连接，后端是内置插件 plugins/weixin_qr（挂在 /api/plugins/weixin-qr/）。
// 登录状态只在发起它的后端进程内存里，所以同一次登录的每个请求都带同一个 Profile 作用域。
const BASE = '/api/plugins/weixin-qr'

export type WeixinQrState = 'cancelled' | 'confirmed' | 'error' | 'expired' | 'scanned' | 'wait'

/** 结果中可能附带的网关重启情况，与 Telegram 扫码保存后的字段一致。 */
export interface WeixinRestartOutcome {
  needs_restart?: boolean
  restart_error?: string
  restart_started?: boolean
}

export interface WeixinQrLogin extends WeixinRestartOutcome {
  message: string
  /** 微信要扫的链接；后端刷新过期二维码后会变化。 */
  qr_content: string
  session_id: string
  state: WeixinQrState
}

/** 把 Profile 同时放进作用域和查询参数：前者选后端进程，后者告诉插件写哪个 Profile。 */
function scoped(path: string, profile?: null | string) {
  const scope = profileScoped(profile)
  const query = scope.profile ? `?profile=${encodeURIComponent(scope.profile)}` : ''

  return { ...scope, path: `${BASE}${path}${query}` }
}

/** 取一张新二维码，后端开始在后台等待扫码。 */
export function startWeixinQrLogin(profile?: null | string): Promise<WeixinQrLogin> {
  return hermesApi<WeixinQrLogin>({ ...scoped('/login/start', profile), method: 'POST', body: {} })
}

/** 查询一次登录的当前状态。 */
export function getWeixinQrLogin(sessionId: string, profile?: null | string): Promise<WeixinQrLogin> {
  return hermesApi<WeixinQrLogin>(scoped(`/login/${encodeURIComponent(sessionId)}`, profile))
}

/** 解绑：清除微信凭据、关闭微信通道并重启网关。 */
export function unbindWeixin(profile?: null | string): Promise<WeixinRestartOutcome & { ok: boolean }> {
  return hermesApi<WeixinRestartOutcome & { ok: boolean }>({ ...scoped('/unbind', profile), method: 'POST', body: {} })
}
