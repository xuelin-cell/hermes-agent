import { app, ipcMain } from 'electron'

import type { LoginIdentity } from './login/session'

/** Fixed upload destination; the renderer never supplies credentials or a URL. */
export function registerSettingsFeedback(identity: () => LoginIdentity | null) {
  ipcMain.handle(
    'hermes:settings:feedback',
    async (_event, input: { bytes: Uint8Array; description: string; date: string }) => {
      const account = identity()

      if (!account) {throw new Error('Sign in before uploading feedback')}
      const bytes = new Uint8Array(input.bytes)

      if (bytes.length < 4 || bytes.length > 20 * 1024 * 1024 || bytes[0] !== 80 || bytes[1] !== 75)
        {throw new Error('Invalid feedback package')}

      const form = new FormData()
      form.append('file', new Blob([bytes], { type: 'application/zip' }), 'feedback.zip')
      form.append('application', 'uniwork')
      form.append('description', String(input.description).slice(0, 10000))
      form.append('problem_date', String(input.date).slice(0, 32))
      form.append('phone', account.phone ?? '')
      form.append('app_version', app.getVersion())

      const response = await fetch('https://maas.ai-yuanjing.com/app/gateway/uniclaw/feedback/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${account.token}` },
        body: form,
        signal: AbortSignal.timeout(30000)
      })

      if (!response.ok) {throw new Error(`Feedback upload failed (${response.status})`)}
      const result = (await response.json()) as { code?: number | string; success?: boolean }

      if (result.success === false || (result.code !== undefined && ![0, 200, '0', '200'].includes(result.code)))
        {throw new Error('Feedback service rejected the upload')}

      if (identity()?.uid !== account.uid) {throw new Error('Account changed during upload')}

      return { ok: true }
    }
  )
}
