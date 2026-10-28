import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { executeAction } from '../src/core/execution.ts'
import type { ProviderExecutors, TransitFileWriter } from '../src/core/types.ts'
import { createMailProviderRuntime } from '../src/mail/imap-smtp/runtime.ts'
import { woMailActions } from '../src/providers/wo_mail/actions.ts'
import { woMailRuntimeConfig } from '../src/providers/wo_mail/config.ts'
import { addWoMailQuota } from '../src/providers/wo_mail/executors.ts'
import { readWoMailQuotaStatus } from '../src/providers/wo_mail/quota.ts'

const runtime = createMailProviderRuntime(woMailRuntimeConfig)
export const tools = woMailActions.map(action => ({
  name: action.name,
  description: `Agent Mail: ${action.description} Requires the user to enable My Mail first.`,
  inputSchema: action.inputSchema
}))

export async function mailAction(input: {
  name: string; args: Record<string, unknown>; values: Record<string, string>;
  directory: string; attachments: string
}, base: ProviderExecutors = runtime.executors) {
  const action = woMailActions.find(action => action.name === input.name)
  if (!action) throw new Error('Unknown mail action')
  const executors = addWoMailQuota(base, { dataDir: () => input.directory })
  const transitFiles: TransitFileWriter = {
    maxBytes: 10 * 1024 * 1024,
    async create(file) {
      if (file.size > this.maxBytes) throw new Error('Attachment too large')
      await mkdir(input.attachments, { recursive: true, mode: 0o700 })
      const name = file.name.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 100) || 'attachment'
      const id = randomBytes(16).toString('hex') + '-' + name
      await writeFile(path.join(input.attachments, id), Buffer.from(await file.arrayBuffer()), { flag: 'wx', mode: 0o600 })
      return { fileId: id, downloadUrl: id, name, mimeType: file.type, sizeBytes: file.size }
    },
    async read() { throw new Error('Unsupported transit operation') },
    async delete() { throw new Error('Unsupported transit operation') }
  }
  const result = await executeAction(action as Parameters<typeof executeAction>[0], executors[`wo_mail.${action.name}`], input.args, {
    getCredential: async () => ({ authType: 'custom_credential', values: input.values,
      profile: { accountId: input.values.email, displayName: input.values.email, grantedScopes: [] }, metadata: {} }),
    transitFiles, signal: AbortSignal.timeout(90_000)
  })
  if (!result.ok) throw new Error(result.error?.message || 'Mail operation failed')
  return result.output
}

export const quotaStatus = readWoMailQuotaStatus

export async function validateMail(values: Record<string, string>) {
  await runtime.credentialValidators.customCredential!({ values }, { fetcher: fetch })
  return { valid: true }
}
