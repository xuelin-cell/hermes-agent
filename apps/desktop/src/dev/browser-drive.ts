import { readBrowserAuth, requestEntryMaas } from '../../../shared/src/browser-maas-auth.js'
import type {
  CloudDriveMutationProgress,
  CloudDriveRequest,
  CloudDriveTransferProgress,
  CloudDriveTransferRequest,
  CloudDriveTransferResult
} from '../../electron/login/contract'

const pause = () => new Promise(resolve => setTimeout(resolve, 400))
const PART = 8 * 1024 * 1024

function selectFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

/** Reuse the desktop bridge shape; only native dialogs and the trusted transport differ. */
export function browserDrive(base: string) {
  const progress = new Set<(value: CloudDriveTransferProgress) => void>()
  const mutations = new Set<(value: CloudDriveMutationProgress) => void>()
  const active = new Map<string, { cancelled: boolean; serverId?: string }>()

  const call = <T>(operation: string, data: unknown) =>
    requestEntryMaas<T>(base, `drive/${operation}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })

  const poll = async <T>(id: string, event: (value: Record<string, unknown>) => void): Promise<T> => {
    for (;;) {
      const value = await call<{ done: boolean; result: T; progress?: Record<string, unknown> }>('status', { id })

      if (value.progress) {
        event(value.progress)
      }

      if (value.done) {
        return value.result
      }

      await pause()
    }
  }

  const emit = (value: CloudDriveTransferProgress) => {
    for (const listener of progress) {
      listener(value)
    }
  }

  const cloudDriveRequest = async (input: CloudDriveRequest) => {
    const value = await call<{ id: string }>('request', { id: crypto.randomUUID(), request: input })

    return poll(value.id, phase => {
      if (phase.phase === 'verifying' && input.requestId) {
        for (const listener of mutations) {
          listener({ id: input.requestId, phase: 'verifying' })
        }
      }
    })
  }

  const oneTransfer = async (
    input: Exclude<CloudDriveTransferRequest, { operation: 'download-many' }>,
    context: { cancelled: boolean; serverId?: string },
    report: Partial<CloudDriveTransferProgress> = {}
  ) => {
    let created: { id: string }

    if (input.operation === 'upload' && !input.artifact) {
      const file = await selectFile()

      if (!file || context.cancelled) {
        return { status: 'cancelled' } as const
      }

      created = await call('upload-start', { id: input.id, name: file.name, size: file.size })
      context.serverId = created.id

      try {
        for (let offset = 0; offset < file.size; offset += PART) {
          if (context.cancelled) {
            return { status: 'cancelled' } as const
          }

          await requestEntryMaas(base, `drive/part/${created.id}`, {
            headers: { 'X-Drive-Offset': String(offset) },
            body: file.slice(offset, offset + PART)
          })
          emit({ id: input.id, name: file.name, completed: Math.min(file.size, offset + PART), total: file.size })
        }

        if (context.cancelled) {
          return { status: 'cancelled' } as const
        }

        await call('upload-finish', { id: created.id, parentAssetId: input.parentAssetId })
      } catch (error) {
        await call('cancel', { id: created.id }).catch(() => undefined)
        throw error
      }
    } else {
      created = await call('transfer', { id: input.id, request: input })
      context.serverId = created.id
    }

    if (context.cancelled) {
      await call('cancel', { id: created.id })
    }

    const result = await poll<CloudDriveTransferResult & { readyForBrowser?: boolean }>(created.id, value =>
      emit({ id: input.id, ...value, ...report } as CloudDriveTransferProgress)
    )

    if (result.status === 'succeeded' && result.readyForBrowser && !context.cancelled) {
      const link = document.createElement('a')
      link.href = `${base.replace(/\/$/, '')}/__entry/drive/files/${created.id}`
      link.download = result.name
      document.body.append(link)
      link.click()
      link.remove()
    }

    return result
  }

  return {
    cloudDriveRequest,
    prepareCloudDriveTurn: async (sessionId: string): Promise<Record<string, string> | null> => {
      if (!readBrowserAuth(base)) {
        return null
      }

      const ready = await call<{ ready: boolean }>('ready', {}).catch(() => ({ ready: false }))

      return ready.ready ? call<Record<string, string>>('grant', { sessionId }).catch(() => null) : null
    },
    cloudDriveAgentReady: async (profile: string) =>
      profile === 'default' && (await call<{ ready: boolean }>('ready', { probe: true })).ready,
    cloudDriveTransfer: async (input: CloudDriveTransferRequest): Promise<CloudDriveTransferResult> => {
      const context = { cancelled: false, serverId: undefined as string | undefined }
      active.set(input.id, context)

      try {
        if (input.operation !== 'download-many') {
          return await oneTransfer(input, context)
        }

        const files: NonNullable<CloudDriveTransferResult['files']> = []

        for (const [index, file] of input.assets.entries()) {
          if (context.cancelled) {
            files.push({ index, name: file.name, status: 'not_started' })

            continue
          }

          const result = await oneTransfer({ ...file, id: `${input.id}-${index}`, operation: 'download' }, context, {
            id: input.id,
            fileIndex: index,
            fileCount: input.assets.length
          }).catch(() => ({ status: 'failed' as const }))

          files.push({ index, name: file.name, status: result.status })
        }

        if (files.every(file => file.status === 'cancelled' || file.status === 'not_started')) {
          return { status: 'cancelled', files }
        }

        return files.every(file => file.status === 'succeeded')
          ? { status: 'succeeded', name: '', files }
          : {
              protocol: 'uniwork.drive-result.v1',
              ok: false,
              status: files.some(file => file.status === 'succeeded') ? 'partial_success' : 'failed',
              code: 'DOWNLOAD_BATCH_PARTIAL',
              files
            }
      } finally {
        active.delete(input.id)
      }
    },
    cancelCloudDriveTransfer: async (id: string) => {
      const operation = active.get(id)

      if (operation) {
        operation.cancelled = true

        if (operation.serverId) {
          await call('cancel', { id: operation.serverId })
        }
      }
    },
    onCloudDriveProgress: (listener: (value: CloudDriveTransferProgress) => void) => {
      progress.add(listener)

      return () => {
        progress.delete(listener)
      }
    },
    onCloudDriveMutationProgress: (listener: (value: CloudDriveMutationProgress) => void) => {
      mutations.add(listener)

      return () => {
        mutations.delete(listener)
      }
    }
  }
}
