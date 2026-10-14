import { useEffect, useRef, useState } from 'react'

import {
  getWeixinQrLogin,
  startWeixinQrLogin,
  unbindWeixin,
  type WeixinQrLogin,
  type WeixinRestartOutcome
} from '@/api/weixin-qr'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorBanner } from '@/components/ui/error-state'
import type { MessagingPlatformInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { QrCode, RefreshCw, Trash2 } from '@/lib/icons'

/** 后台仍在等待扫码的状态。 */
const ACTIVE_STATES = new Set(['scanned', 'wait'])

/** 轮询间隔；后端自己长轮询 iLink，这里只读内存里的状态。 */
export const WEIXIN_POLL_MS = 1500

/** 把微信要扫的链接画成二维码图片；与 UniWork 相同用最高纠错级别，中等级别时微信可能扫不出。 */
async function renderQr(payload: string): Promise<string> {
  const QRCode = await import('qrcode')

  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'H', margin: 4, width: 240 })
}

export interface WeixinQrSetupProps {
  /** 扫码确认、后端保存凭据之后调用，参数是网关重启情况。 */
  onSaved: (result: WeixinRestartOutcome) => void
  /** 解绑完成后调用。 */
  onUnbound: (result: WeixinRestartOutcome) => void
  platform: MessagingPlatformInfo
  /** 页面当前查看的 Profile（undefined 表示当前 Profile）。 */
  scopeProfile: string | undefined
}

/** 个人微信扫码连接：点按钮出二维码，扫码确认后由后端保存凭据并重启网关。 */
export function WeixinQrSetup({ onSaved, onUnbound, platform, scopeProfile }: WeixinQrSetupProps) {
  const { t } = useI18n()
  const q = t.messaging.weixinQr
  const [login, setLogin] = useState<null | WeixinQrLogin>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [confirmUnbind, setConfirmUnbind] = useState(false)
  // 页面每次渲染都会传新的回调；用 ref 读最新值，避免轮询计时被反复重置。
  const onSavedRef = useRef(onSaved)
  const active = login !== null && ACTIVE_STATES.has(login.state)

  onSavedRef.current = onSaved

  // 二维码过期后后端会换新的链接，这里跟着重画。
  const qrContent = login?.qr_content ?? ''

  useEffect(() => {
    if (!qrContent) {
      setQrDataUrl('')

      return
    }

    let live = true

    void renderQr(qrContent).then(url => live && setQrDataUrl(url))

    return () => {
      live = false
    }
  }, [qrContent])

  // 等待扫码期间轮询状态；确认后交给页面刷新和处理网关重启。
  const sessionId = active ? login.session_id : null

  useEffect(() => {
    if (!sessionId) {
      return
    }

    let cancelled = false
    let timer: null | number = null

    const poll = async () => {
      try {
        const next = await getWeixinQrLogin(sessionId, scopeProfile)

        if (cancelled) {
          return
        }

        if (next.state === 'confirmed') {
          setLogin(null)
          onSavedRef.current(next)

          return
        }

        setLogin(next)

        if (ACTIVE_STATES.has(next.state)) {
          timer = window.setTimeout(() => void poll(), WEIXIN_POLL_MS)
        }
      } catch (pollError) {
        // 与 UniWork 相同：查询出错（含后端已不保存这次登录）就停下，让用户重新生成。
        if (!cancelled) {
          setLogin(current => (current ? { ...current, message: String(pollError), state: 'error' } : current))
        }
      }
    }

    timer = window.setTimeout(() => void poll(), WEIXIN_POLL_MS)

    return () => {
      cancelled = true

      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [scopeProfile, sessionId])

  /** 取一张新二维码；之前未完成的登录由后端取消。 */
  const start = async () => {
    setStarting(true)
    setError('')

    try {
      setLogin(await startWeixinQrLogin(scopeProfile))
    } catch (startError) {
      setLogin(null)
      setError(q.startFailed(String(startError)))
    } finally {
      setStarting(false)
    }
  }

  /** 关闭二维码；后端等待到期自行结束，重新生成时旧二维码作废。 */
  const close = () => {
    setLogin(null)
    setError('')
  }

  /** 确认解绑后清除凭据；失败时抛出，让确认框显示错误。 */
  const unbind = async () => {
    onUnbound(await unbindWeixin(scopeProfile))
  }

  const finished = login !== null && !active

  return (
    <div className="rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-surface-secondary,transparent) p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="text-[length:var(--conversation-text-font-size)] font-medium">{q.title}</span>
          <p className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
            {q.help}
          </p>
        </div>
        {!login && (
          <div className="flex flex-wrap gap-2">
            <Button disabled={starting} onClick={() => void start()} size="sm">
              <QrCode />
              {starting ? q.starting : platform.configured ? q.rescan : q.connect}
            </Button>
            {platform.configured && !starting && (
              <Button onClick={() => setConfirmUnbind(true)} size="sm" variant="ghost">
                <Trash2 />
                {q.unbind}
              </Button>
            )}
          </div>
        )}
      </div>

      {platform.configured && !login && (
        <div className="mt-2">
          <Badge variant="success">{t.messaging.states.connected}</Badge>
        </div>
      )}

      {error && <ErrorBanner className="mt-3">{error}</ErrorBanner>}

      {login && (
        <div className="mt-3 grid gap-4 border-t border-(--ui-stroke-secondary) pt-3 sm:grid-cols-[minmax(0,1fr)_240px]">
          <div className="grid content-start gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {login.state === 'wait' && <Badge variant="warn">{q.waiting}</Badge>}
              {login.state === 'scanned' && <Badge variant="success">{q.scanned}</Badge>}
              {login.state === 'expired' && <Badge variant="destructive">{q.expired}</Badge>}
              {(login.state === 'error' || login.state === 'cancelled') && (
                <Badge variant="destructive">{q.failed}</Badge>
              )}
            </div>
            {login.state === 'error' && login.message && (
              <p className="text-xs text-muted-foreground">{login.message}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {finished && (
                <Button disabled={starting} onClick={() => void start()} size="sm">
                  <RefreshCw />
                  {starting ? q.starting : q.refresh}
                </Button>
              )}
              <Button onClick={close} size="sm" variant="ghost">
                {t.common.cancel}
              </Button>
            </div>
          </div>

          {active && qrDataUrl && (
            <div className="flex flex-col items-center gap-2">
              <img alt={q.title} className="size-56 rounded-md bg-white p-2" src={qrDataUrl} />
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        busyLabel={q.unbinding}
        cancelLabel={t.common.cancel}
        confirmLabel={q.unbind}
        description={q.unbindDesc}
        destructive
        onClose={() => setConfirmUnbind(false)}
        onConfirm={unbind}
        open={confirmUnbind}
        title={q.unbindTitle}
      />
    </div>
  )
}
