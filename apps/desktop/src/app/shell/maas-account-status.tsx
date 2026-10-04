import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { notify } from '@/store/notifications'

import type { LoginAccount } from '../../../electron/login/contract'

import type { StatusbarItem } from './statusbar-controls'

/** 账号旁只提供一个退出入口，统一确认后交给主进程处理停止与重启。 */
function AccountLogout({ account }: { account: LoginAccount }) {
  const [open, setOpen] = useState(false)
  const [expired, setExpired] = useState(false)
  const { t } = useI18n()
  const copy = t.desktopLogin

  useEffect(() => {
    if (account.planAuthRejected) {
      notify({ id: 'maas-plan-rejected', kind: 'warning', message: copy.planAuthRejected, placement: 'bottom-right' })
    }
  }, [account.planAuthRejected, copy.planAuthRejected])

  useEffect(() => {
    if (expired) {
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let notified = false

    /** 到期或唤醒后只提示一次，不注销、不停止任务、不移动焦点。 */
    function checkExpiry(): void {
      clearTimeout(timer)

      if (notified) {
        return
      }

      const remaining = account.expiresAt - Date.now()

      if (remaining <= 0) {
        notified = true
        setExpired(true)
        notify({ id: 'maas-login-expired', kind: 'warning', message: copy.expiredRunning, placement: 'bottom-right' })
      } else {
        timer = setTimeout(checkExpiry, Math.min(60_000, remaining))
      }
    }

    checkExpiry()
    window.addEventListener('focus', checkExpiry)

    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', checkExpiry)
    }
  }, [account.expiresAt, copy.expiredRunning, expired])

  return (
    <>
      <span className="inline-flex h-full shrink-0 items-center gap-1 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)">
        <span>{account.maskedPhone}</span>
        {expired ? (
          <Tip label={copy.expiredRunning}>
            <span>{copy.expiredLabel}</span>
          </Tip>
        ) : null}
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

/** 读取本次运行账号，保留到期账号和退出入口；不持久化身份、不执行注销。 */
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

      const valid = next ?? null
      // 相同展示身份保持引用，避免焦点／定时刷新重挂账号组件并关闭退出确认。
      setAccount(previous =>
        previous?.maskedPhone === valid?.maskedPhone &&
        previous?.expiresAt === valid?.expiresAt &&
        previous?.planAuthRejected === valid?.planAuthRejected
          ? previous
          : valid
      )

      if (valid) {
        timer = setTimeout(() => void refresh(), 60_000)
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
            render: () => <AccountLogout account={account} />,
            className: 'shrink-0'
          }
        : null,
    [account]
  )
}
