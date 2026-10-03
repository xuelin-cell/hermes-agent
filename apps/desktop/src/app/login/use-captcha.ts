import { useCallback, useEffect, useRef, useState } from 'react'

import type { DesktopLoginBridge, LoginCaptcha } from '../../../electron/login/contract'

/** 管理验证码请求与页面生命周期，只允许最新刷新结果更新图片。 */
export function useCaptcha(bridge?: Pick<DesktopLoginBridge, 'captcha'>) {
  const [captcha, setCaptcha] = useState<LoginCaptcha | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const generation = useRef(0)

  /** 刷新期间清除旧图片，失败后允许用户重试。 */
  const refresh = useCallback(async () => {
    if (!bridge) {
      return
    }

    const current = ++generation.current
    setCaptcha(null)
    setFailed(false)
    setLoading(true)

    try {
      const result = await bridge.captcha()

      if (current !== generation.current) {
        return
      }

      setCaptcha(result.ok ? result.captcha : null)
      setFailed(!result.ok)
    } catch {
      if (current === generation.current) {
        setFailed(true)
      }
    } finally {
      if (current === generation.current) {
        setLoading(false)
      }
    }
  }, [bridge])

  useEffect(() => {
    const requests = generation
    void refresh()

    return () => {
      requests.current++
    }
  }, [refresh])

  return { captcha, loading, failed, refresh }
}
