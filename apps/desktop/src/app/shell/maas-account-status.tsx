import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { signOutDescription } from '@/lib/browser-shell'
import { notify } from '@/store/notifications'

import { PlanUsagePanel } from './plan-usage/panel'

import type { LoginAccount } from '../../../electron/login/contract'

/** 头像卡片整合套餐和设置，退出仍统一确认后交给主进程处理停止与重启。 */
function AccountLogout({ account }: { account: LoginAccount }) {
  const [open, setOpen] = useState(false)
  const [expired, setExpired] = useState(false)
  const { locale, t } = useI18n()
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
      <PlanUsagePanel
        account={account}
        onLogout={() => setOpen(true)}
        trigger={
          <Button data-slot="sidebar-account-trigger" aria-label={account.maskedPhone} variant="ghost" type="button">
            <span data-slot="sidebar-account-avatar" aria-hidden="true">
              <Codicon name="account" size="1rem" />
            </span>
            <span className="min-w-0 flex-1 truncate text-left">{account.maskedPhone}</span>
            {expired && <span className="text-xs text-muted-foreground">{copy.expiredLabel}</span>}
            <Codicon name="chevron-up" size="0.875rem" />
          </Button>
        }
      />
      <ConfirmDialog
        busyLabel={copy.logoutBusy}
        confirmLabel={copy.logout}
        description={signOutDescription(locale) ?? copy.logoutDescription}
        onClose={() => setOpen(false)}
        onConfirm={() => window.hermesDesktop.logoutMaasAccount()}
        open={open}
        title={copy.logoutTitle}
      />
    </>
  )
}

/** 读取本次运行账号，保留到期账号和退出入口；不持久化身份、不执行注销。 */
export function useMaasAccount(): LoginAccount | null {
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

  return account
}

/** 侧栏底部统一承载账号菜单，沿用主进程账号读取、到期提醒和安全退出。 */
export function MaasAccountSidebar() {
  const account = useMaasAccount()
  return account ? (
    <div data-slot="sidebar-account" className="shrink-0 px-3 pb-3 pt-2">
      <AccountLogout account={account} key={`${account.maskedPhone}:${account.expiresAt}`} />
    </div>
  ) : null
}
