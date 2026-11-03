import type { AgentMailRequest, AgentMailResult } from '../../electron/agent-mail/contract'
import { requestEntryMaas } from '../../../shared/src/browser-maas-auth.js'

export function browserMail(base: string) {
  return {
    agentMail: async (input: AgentMailRequest): Promise<AgentMailResult> => {
      const result = await requestEntryMaas<AgentMailResult>(base, 'mail', {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
      })
      if (input.operation === 'action' && input.action === 'download_attachment') {
        const data = result.data as { file?: { downloadUrl?: string } } | undefined
        if (data?.file?.downloadUrl) data.file.downloadUrl = new URL(data.file.downloadUrl, location.origin).href
      }
      return result
    }
  }
}

/** Download this instance's mail attachment without depending on pop-up permission. */
export function openMailAttachment(base: string, url: string): boolean {
  const target = new URL(url, location.origin)
  const prefix = `${base.replace(/\/$/, '')}/__hermes_backend/api/plugins/cloud-mail/attachments/`
  if (target.origin !== location.origin || !target.pathname.startsWith(prefix) || target.search || target.hash) return false
  const anchor = document.createElement('a')
  anchor.href = target.href
  anchor.download = ''
  anchor.click()
  return true
}
