import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n/context'

import type { DesktopLoginBridge, PlanResult } from '../../../electron/login/contract'

interface PlanStatusProps {
  bridge: Pick<DesktopLoginBridge, 'plan'>
}

/** 只展示当前账号套餐，查询失败或无套餐都不改变登录状态。 */
export function PlanStatus({ bridge }: PlanStatusProps) {
  const { t } = useI18n()
  const copy = t.desktopLogin
  const [result, setResult] = useState<PlanResult | null>(null)
  const [pending, setPending] = useState(true)
  const generation = useRef(0)

  /** 手动重试只查询套餐；卸载或新请求后，迟到结果不更新页面。 */
  const query = useCallback(async () => {
    const current = ++generation.current
    setPending(true)
    setResult(null)

    try {
      const response = await bridge.plan()

      if (current === generation.current) {
        setResult(response)
      }
    } catch {
      if (current === generation.current) {
        setResult({ status: 'failed' })
      }
    } finally {
      if (current === generation.current) {
        setPending(false)
      }
    }
  }, [bridge])

  useEffect(() => {
    const requests = generation
    void query()

    return () => {
      requests.current++
    }
  }, [query])

  return (
    <section aria-busy={pending} aria-label={copy.planTitle} className="space-y-2 pt-3">
      <p className="font-medium">{copy.planTitle}</p>
      {pending ? (
        <Loader className="size-5" label={copy.planTitle} />
      ) : result?.status === 'available' ? (
        <ul className="space-y-1 break-words">
          {result.models.map((model, index) => (
            <li key={index}>
              {model.name}
              {model.isDefault ? ` (${copy.planDefault})` : ''}
            </li>
          ))}
        </ul>
      ) : result?.status === 'empty' ? (
        <p>{copy.planEmpty}</p>
      ) : (
        <div className="flex items-center gap-2">
          <p>{result?.status === 'failed' && result.reason === 'auth' ? copy.planAuthRejected : copy.planError}</p>
          <Button onClick={() => void query()} size="inline" type="button" variant="textStrong">
            {copy.planRetry}
          </Button>
        </div>
      )}
      <p className="text-muted-foreground">{copy.planCustom}</p>
    </section>
  )
}
