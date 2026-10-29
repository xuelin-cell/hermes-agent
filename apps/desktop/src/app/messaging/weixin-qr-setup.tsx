import { useEffect, useRef, useState } from 'react'

import {
  getWeixinQrLogin,
  startWeixinQrLogin,
  type WeixinQrLogin,
  type WeixinRestartOutcome
} from '@/api/weixin-qr'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorBanner } from '@/components/ui/error-state'
import type { MessagingPlatformInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { CheckCircle2, Loader2, QrCode, RefreshCw } from '@/lib/icons'

import { PlatformCard } from './platform-card'
import { isBrowserShell } from '@/lib/browser-shell'
import { WeixinGroupSettings } from './weixin-group-settings'

const ACTIVE_STATES = new Set(['scanned', 'wait'])
export const WEIXIN_POLL_MS = 1500

/** 二维码沿用最高纠错级别和完整留白，保证浅色与深色界面都能扫码。 */
async function renderQr(payload: string): Promise<string> {
  const QRCode = await import('qrcode')

  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'H', margin: 4, width: 240 })
}

export interface WeixinQrSetupProps {
  onSaved: (result: WeixinRestartOutcome) => void
  onUnbind: () => Promise<void>
  busy?: boolean
  pending?: boolean
  platform: MessagingPlatformInfo
  scopeProfile: string | undefined
}

/** 微信卡片复用既有扫码、保存和解绑接口，不显示或编辑底层 token。 */
export function WeixinQrSetup({ onSaved, onUnbind, busy = false, pending, platform, scopeProfile }: WeixinQrSetupProps) {
  const { t } = useI18n()
  const q = t.messaging.weixinQr
  const [login, setLogin] = useState<WeixinQrLogin | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [confirmUnbind, setConfirmUnbind] = useState(false)
  const onSavedRef = useRef(onSaved)
  const startRevision = useRef(0)
  const successTimer = useRef<number | null>(null)
  onSavedRef.current = onSaved
  const active = login !== null && ACTIVE_STATES.has(login.state)
  const qrContent = login?.qr_content || ''

  useEffect(() => {
    let live = true
    setQrDataUrl('')

    if (qrContent) {
      void renderQr(qrContent)
        .then(url => {
          if (live) {
            setQrDataUrl(url)
          }
        })
        .catch(() => {
          if (live) {
            setError(q.failed)
          }
        })
    }

    return () => {
      live = false
    }
  }, [q.failed, qrContent])

  // 只在卸载时作废请求并清除本组件的成功提示计时器。

  useEffect(
    () => () => {
      startRevision.current += 1

      if (successTimer.current !== null) {
        window.clearTimeout(successTimer.current)
      }
    },
    []
  )

  const sessionId = active ? login.session_id : null

  // ref 只保存本次成功展示的计时器句柄，并非响应式状态的镜像。
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!sessionId) {
      return
    }

    let cancelled = false
    let timer: number | null = null

    /** 一次查询结束后再安排下一次；关闭页面或扫码结束后不再发布迟到结果。 */
    const poll = async () => {
      try {
        const next = await getWeixinQrLogin(sessionId, scopeProfile)

        if (cancelled) {
          return
        }

        setLogin(next)

        if (next.state === 'confirmed') {
          onSavedRef.current(next)
          successTimer.current = window.setTimeout(() => {
            setPanelOpen(false)
            setLogin(null)
          }, 1200)
        } else if (ACTIVE_STATES.has(next.state)) {
          timer = window.setTimeout(() => void poll(), WEIXIN_POLL_MS)
        }
      } catch (cause) {
        if (!cancelled) {
          setLogin(current => (current ? { ...current, message: String(cause), state: 'error' } : current))
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

  /** 在同一位置显示加载、二维码和失败状态；刷新仍调用原来的取码接口。 */
  async function start() {
    const revision = ++startRevision.current

    if (successTimer.current !== null) {
      window.clearTimeout(successTimer.current)
    }

    setPanelOpen(true)
    setLogin(null)
    setError('')
    setStarting(true)

    try {
      const next = await startWeixinQrLogin(scopeProfile)

      if (revision === startRevision.current) {
        setLogin(next)
      }
    } catch (cause) {
      if (revision === startRevision.current) {
        setError(q.startFailed(String(cause)))
      }
    } finally {
      if (revision === startRevision.current) {
        setStarting(false)
      }
    }
  }

  /** 收起只停止页面轮询；沿用既有后端到期处理，不引入新的取消接口。 */
  function close() {
    startRevision.current += 1

    if (successTimer.current !== null) {
      window.clearTimeout(successTimer.current)
    }

    setPanelOpen(false)
    setStarting(false)
    setLogin(null)
    setError('')
  }

  /** 确认后提交后台解绑；关闭弹窗不等待网关停止或重启。 */
  async function unbind() {
    await onUnbind()
    close()
  }

  const finished = !!login && !active
  const loadingQr = starting || (!!qrContent && !qrDataUrl && !error)

  const overlay =
    login?.state === 'scanned'
      ? q.scanned
      : login?.state === 'expired'
        ? q.expired
        : login?.state === 'confirmed'
          ? t.messaging.saved
          : login?.state === 'error' || login?.state === 'cancelled' || error
            ? q.failed
            : ''

  return (
    <>
      <PlatformCard
        actions={
          <>
            <Button
              aria-label={platform.configured ? q.rescan : q.connect}
              disabled={starting || busy}
              onClick={() => (panelOpen ? close() : void start())}
              size="sm"
              variant="outline"
            >
              {platform.configured ? q.rescan : t.messaging.cards.configure}
            </Button>
            {platform.configured && (
              <Button disabled={starting || busy} onClick={() => setConfirmUnbind(true)} size="sm" variant="outline">
                {q.unbind}
              </Button>
            )}
          </>
        }
        id="weixin"
        pending={pending}
        platform={platform}
      >
        {isBrowserShell() && platform.configured && <WeixinGroupSettings busy={busy} />}
        {platform.error_message && <ErrorBanner className="mt-3">{platform.error_message}</ErrorBanner>}
        {panelOpen && (
          <div className="mt-4 flex flex-col items-center gap-3 border-t border-dashed border-(--ui-stroke-secondary) pt-4">
            <p className="flex items-center gap-2 text-xs text-(--ui-text-secondary)">
              <QrCode className="size-4" />
              {q.waiting}
            </p>
            <div
              aria-busy={loadingQr}
              className="relative flex size-60 max-w-full items-center justify-center overflow-hidden rounded-lg border border-(--ui-stroke-secondary)"
            >
              {loadingQr ? (
                <Loader2 aria-label={q.starting} className="size-7 animate-spin" />
              ) : (
                qrDataUrl && <img alt={q.title} className="size-full object-contain" src={qrDataUrl} />
              )}
              {overlay && !starting && (
                <div
                  className="absolute inset-0 flex items-center justify-center gap-2 bg-background/95 p-4 text-center text-sm"
                  role="status"
                >
                  {login?.state === 'confirmed' && <CheckCircle2 className="size-5 text-primary" />}
                  {overlay}
                </div>
              )}
            </div>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            {login?.state === 'error' && login.message && <ErrorBanner>{login.message}</ErrorBanner>}
            <div className="flex flex-wrap justify-center gap-2">
              {(finished || error) && login?.state !== 'confirmed' && (
                <Button disabled={starting} onClick={() => void start()} size="sm" variant="outline">
                  <RefreshCw />
                  {q.refresh}
                </Button>
              )}
              <Button onClick={close} size="sm" variant="text">
                {t.common.cancel}
              </Button>
            </div>
          </div>
        )}
      </PlatformCard>
      <ConfirmDialog
        busyLabel={q.unbinding}
        cancelLabel={t.common.cancel}
        confirmLabel={q.unbind}
        description={q.unbindDesc}
        destructive
        dismissOnConfirm
        onClose={() => setConfirmUnbind(false)}
        onConfirm={unbind}
        open={confirmUnbind}
        title={q.unbindTitle}
      />
    </>
  )
}
