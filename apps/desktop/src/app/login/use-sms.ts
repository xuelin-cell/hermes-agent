import { useEffect, useRef, useState } from 'react'

import type { DesktopLoginBridge, SmsRequest, SmsResult } from '../../../electron/login/contract'

/** 管理短信提交和主进程给出的重发期限，切到后台也不延长倒计时。 */
export function useSms(bridge?: DesktopLoginBridge) {
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<SmsResult | null>(null)
  const [seconds, setSeconds] = useState(0)
  const busy = useRef(false)
  const deadline = useRef(0)

  useEffect(() => {
    if (!result || !('retryAt' in result)) {
      return
    }

    /** 按真实截止时间重算剩余秒数，避免定时器暂停后显示旧秒数。 */
    function tick(): void {
      const left = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000))
      setSeconds(left)

      if (!left) {
        clearInterval(timer)
      }
    }

    const timer = setInterval(tick, 1000)

    return () => clearInterval(timer)
  }, [result])

  /** 即时锁阻止同一帧内重复点击；未知错误仅显示安全提示。 */
  async function send(input: SmsRequest): Promise<void> {
    if (!bridge || busy.current || Date.now() < deadline.current) {
      return
    }

    busy.current = true
    setPending(true)
    setResult(null)

    try {
      const response = await bridge.sendSms(input)
      deadline.current = 'retryAt' in response ? response.retryAt : 0
      setSeconds(Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000)))
      setResult(response)
    } catch {
      setResult({ ok: false, error: 'failed' })
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  return { pending, seconds, result, send }
}
