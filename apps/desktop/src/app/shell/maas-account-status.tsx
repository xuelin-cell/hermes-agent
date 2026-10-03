import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useI18n } from '@/i18n'

import type { LoginAccount } from '../../../electron/login/contract'

import type { StatusbarItem } from './statusbar-controls'

/** 账号旁只提供一个退出入口，统一确认后交给主进程处理停止与重启。 */
function AccountLogout({ phone }: { phone: string }) {
  const [open, setOpen] = useState(false)
  const { t } = useI18n()
  const copy = t.desktopLogin

  return (
    <>
      <span className="inline-flex h-full shrink-0 items-center gap-1 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)">
        <span>{phone}</span>
        <span aria-hidden="true">|</span>
        <Button className="text-[0.6875rem]" onClick={() => setOpen(true)} size="inline" variant="text">
          {copy.logout}
        </Button>
      </span>
      <ConfirmDialog
        busyLabel={copy.logoutBusy}
        confirmLabel={copy.logout}
        description={copy.logoutDescription}
        onClose={() => setOpen(false)}
        onConfirm={() => window.hermesDesktop.logoutMaasAccount()}
        open={open}
        title={copy.logoutTitle}
      />
    </>
  )
}

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
            render: () => <AccountLogout phone={account.maskedPhone} />,
            className: 'shrink-0'
          }
        : null,
    [account]
  )
}
