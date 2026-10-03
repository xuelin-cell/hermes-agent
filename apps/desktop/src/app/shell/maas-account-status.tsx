import { useEffect, useMemo, useState } from 'react'

import type { LoginAccount } from '../../../electron/login/contract'

import type { StatusbarItem } from './statusbar-controls'

/** 读取主进程账号并在到期或重新聚焦时刷新；不持久化身份、不执行注销。 */
export function useMaasAccountStatusbarItem(): StatusbarItem | null {
  const [account, setAccount] = useState<LoginAccount | null>(null)

  useEffect(() => {
    let active = true
    let generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    /** 迟到响应和失败都不能把旧账号继续显示在当前窗口。 */
    async function refresh(): Promise<void> {
      const request = ++generation
      clearTimeout(timer)
      const next = await window.hermesDesktop?.getMaasAccount?.().catch(() => null)

      if (!active || request !== generation) {
        return
      }

      const valid = next && next.expiresAt > Date.now() ? next : null
      setAccount(valid)

      if (valid) {
        timer = setTimeout(() => void refresh(), Math.min(60_000, valid.expiresAt - Date.now()))
      }
    }

    /** 恢复窗口焦点时重新读取主进程状态，覆盖休眠后的旧显示。 */
    function onFocus(): void {
      void refresh()
    }

    void refresh()
    window.addEventListener('focus', onFocus)

    return () => {
      active = false
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return useMemo(
    () =>
      account
        ? {
            id: 'maas-account',
            variant: 'text',
            label: account.maskedPhone,
            className: 'shrink-0'
          }
        : null,
    [account]
  )
}
