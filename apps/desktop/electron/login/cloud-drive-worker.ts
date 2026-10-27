import { once } from 'node:events'
import path from 'node:path'
/** Entry's private stdio worker reuses the desktop protocol, never its Electron IPC. */
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

import { CloudDriveClient, CloudDriveOperationError } from './cloud-drive'
import { driveFileName, executeDriveMcpAction } from './cloud-drive-mcp-actions'
import { DRIVE_MCP_TOOLS, parseDriveMcpInput } from './cloud-drive-mcp-tools'
import { CloudDriveTransfers } from './cloud-drive-transfers'
import { isCloudDriveReadOperation } from './contract'
import type { LoginIdentity } from './session'

let upstreamRequest: typeof fetch = fetch

const limitedRequest: typeof fetch = async (url, options) => {
  const response = await upstreamRequest(url, options)

  if (!String(url).includes('/drive/content?') || !response.ok || !response.body) {
    return response
  }

  const maximum = 512 * 1024 * 1024

  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body.cancel()
    throw new CloudDriveOperationError('failed', 'FILE_TOO_LARGE')
  }

  let bytes = 0

  return new Response(
    response.body.pipeThrough(
      new TransformStream({
        transform(chunk, target) {
          bytes += chunk.byteLength

          if (bytes > maximum) {
            throw new CloudDriveOperationError('failed', 'FILE_TOO_LARGE')
          }

          target.enqueue(chunk)
        }
      })
    ),
    { status: response.status, headers: response.headers }
  )
}

const contexts = new Map<
  string,
  { identity: LoginIdentity | null; drive: CloudDriveClient; transfers: CloudDriveTransfers; active: number }
>()

const running = new Map<string, AbortController>()
let owner = 0

async function send(value: unknown) {
  if (!process.stdout.write(JSON.stringify(value) + '\n')) {
    await once(process.stdout, 'drain')
  }
}

async function handle(input: any) {
  const { id, action } = input

  if (action === 'tools') {
    return send({
      id,
      result: DRIVE_MCP_TOOLS.map(tool => ({
        ...tool,
        description: tool.description
          .replace('当前桌面账号', '当前授权账号')
          .replace('本机 path', '实例内 path')
          .replace('仅适用于与桌面同机的 Hermes。', '')
          .replace('当前机器', '当前用户实例')
      }))
    })
  }

  if (action === 'cancel') {
    running.get(input.target)?.abort()

    return send({ id, result: {} })
  }

  const controller = new AbortController()
  running.set(id, controller)
  let counted: { active: number } | undefined
  let lastProgress = 0

  const notifyProgress = (value: { phase?: string; completed?: number; total?: number | null }) => {
    if (value.phase || Date.now() - lastProgress >= 200 || value.completed === value.total) {
      lastProgress = Date.now()
      void send({ id, progress: value })
    }
  }

  try {
    if (action === 'logout') {
      const old = contexts.get(input.key)

      if (old) {
        old.identity = null
        old.transfers.cancelAll()
        contexts.delete(input.key)
      }

      return await send({ id, result: {} })
    }

    const now = Date.now()

    for (const [key, value] of contexts) {
      if (!value.identity || value.identity.expiresAt <= now) {
        value.identity = null
        value.transfers.cancelAll()
        contexts.delete(key)
      }
    }

    let context = contexts.get(input.key)

    if (!context) {
      if (contexts.size >= 64) {
        const idle = [...contexts].find(([, value]) => value.active === 0)

        if (!idle) {
          throw new CloudDriveOperationError('failed', 'SERVICE_BUSY')
        }

        idle[1].identity = null
        idle[1].transfers.cancelAll()
        contexts.delete(idle[0])
      }

      context = { identity: input.identity, drive: null!, transfers: null!, active: 0 }
      const captured = context
      context.drive = new CloudDriveClient(() => captured.identity, limitedRequest)
      context.transfers = new CloudDriveTransfers(context.drive, path.join(input.root, 'previews'))
      contexts.set(input.key, context)
    }

    if (!context.identity || context.identity.token !== input.identity.token) {
      throw new Error('Invalid identity')
    }

    context.active++
    counted = context
    const scope = AbortSignal.any([controller.signal, AbortSignal.timeout(720_000)])

    const parsedAction = async () => {
      const parsed = parseDriveMcpInput(input.name, input.args)

      if (!parsed) {
        throw new CloudDriveOperationError('failed', 'INVALID_ARGUMENT')
      }

      return action === 'parse' ? parsed : executeDriveMcpAction(context.drive, input.name, parsed, scope)
    }

    const handlers: Record<string, () => Promise<unknown>> = {
      request: async () => {
        const route = new URL(input.request.route, 'https://drive.invalid')

        if (
          (route.searchParams.has('space_id') && route.searchParams.get('space_id') !== 'personal') ||
          (input.request.body?.space_id && input.request.body.space_id !== 'personal')
        ) {
          throw new CloudDriveOperationError('failed', 'INVALID_ARGUMENT')
        }

        return context.drive.execute(input.request, scope, () => {
          void send({ id, progress: { phase: 'verifying' } })
        })
      },
      action: parsedAction,
      parse: parsedAction,
      'release-preview': async () => {
        await context.transfers.clearPreviews(input.owner)

        return {}
      },
      name: async () => {
        const details = await context.drive.execute(
          { route: '/unicom/FileDetails', method: 'POST', body: { fileId: input.assetId } },
          scope
        )

        return { name: driveFileName(details) }
      },
      transfer: async () => {
        const currentOwner = ++owner
        controller.signal.addEventListener('abort', () => context.transfers.cancel(currentOwner), { once: true })

        const result = await context.transfers.run(currentOwner, input.request, {
          selectUpload: async () => input.file,
          selectDownload: async () => input.file,
          progress: notifyProgress
        })

        return result.status === 'succeeded' && result.preview
          ? { ...result, workerPreviewOwner: currentOwner }
          : result
      }
    }

    const handler = handlers[action]

    if (!handler) {
      throw new CloudDriveOperationError('failed', 'INVALID_ARGUMENT')
    }

    const result = await handler()
    await send({ id, result })
  } catch (error) {
    await send({
      id,
      result:
        error instanceof CloudDriveOperationError
          ? error.result
          : {
              protocol: 'uniwork.drive-result.v1',
              ok: false,
              status: action === 'request' && !isCloudDriveReadOperation(input.request) ? 'outcome_unknown' : 'failed',
              code: controller.signal.aborted ? 'CANCELLED' : 'SERVICE_ERROR'
            }
    })
  } finally {
    running.delete(id)

    if (counted) {
      counted.active--
    }
  }
}

export function startDriveWorker(request: typeof fetch = fetch) {
  upstreamRequest = request
  createInterface({ input: process.stdin, crlfDelay: Infinity })
    .on('line', line => {
      try {
        void handle(JSON.parse(line))
      } catch {
        process.exitCode = 1
      }
    })
    .on('close', () => {
      for (const value of running.values()) {
        value.abort()
      }

      process.exit(0)
    })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDriveWorker()
}
