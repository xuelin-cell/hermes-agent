import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import type { LocalConnectorResult } from '../../../../electron/open-connector/contract'

export interface WecomQrFormProps {
  request: (operation: 'qr.start' | 'qr.poll' | 'qr.cancel', sessionId?: string) => Promise<LocalConnectorResult | null>
  onConnected: () => void
}

export function WecomQrForm({ request, onConnected }: WecomQrFormProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.recommended
  const [image, setImage] = useState('')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let sessionId: string | undefined
    setImage('')
    setError('')

    async function poll() {
      try {
        const result = await request('qr.poll', sessionId)

        if (stopped || !result) {
          return
        }

        if (result.qrState === 'confirmed') {
          onConnected()

          return
        }

        if (result.qrState === 'expired') {
          setImage('')
          setError(copy.qrExpired)

          return
        }

        timer = setTimeout(() => void poll(), 3000)
      } catch (reason) {
        if (!stopped) {
          setError(String(reason instanceof Error ? reason.message : reason))
        }
      }
    }

    void request('qr.start')
      .then(result => {
        if (stopped || !result) {
          return
        }

        sessionId = result.sessionId
        setImage(result.qrImage || '')
        timer = setTimeout(() => void poll(), 3000)
      })
      .catch(reason => {
        if (!stopped) {
          setError(String(reason instanceof Error ? reason.message : reason))
        }
      })

    return () => {
      stopped = true
      clearTimeout(timer)
      void request('qr.cancel', sessionId).catch(() => undefined)
    }
    // The mounted dialog owns exactly one scope and QR session; rerenders must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  return (
    <div className="mt-connector-qr">
      {image && <img alt={copy.qrHint} height={240} src={image} width={240} />}
      <p role="status">{copy.qrHint}</p>
      {error && <p role="alert">{error}</p>}
      <Button onClick={() => setRevision(value => value + 1)} variant="secondary">
        {copy.qrRefresh}
      </Button>
    </div>
  )
}
