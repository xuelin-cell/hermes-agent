import { randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'

import { OFFICE_EXTENSIONS } from '../../../shared/src/office-preview'

import type { CloudDriveClient } from './cloud-drive'
import { CloudDriveOperationError } from './cloud-drive'
import type { AuthorizedArtifactFile } from './cloud-drive-artifact-source'
import { type CloudDriveOfficePreview, CLOUD_DRIVE_PREVIEW_BYTES as PREVIEW_BYTES } from './cloud-drive-office-preview'
import type {
  CloudDriveTransferFileResult,
  CloudDriveTransferProgress,
  CloudDriveTransferRequest,
  CloudDriveTransferResult
} from './contract'

const PART_BYTES = 8 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

const TEXT_EXT = new Set(['.txt', '.csv', '.md', '.mdx', '.markdown', '.json', '.xml', '.html', '.htm'])

const PREVIEW_KINDS = new Map<string, 'image' | 'pdf' | 'text' | 'office'>([
  ...Object.keys(IMAGE_MIME).map(extension => [extension, 'image'] as const),
  ['.pdf', 'pdf'],
  ...Array.from(TEXT_EXT, extension => [extension, 'text'] as const),
  ...Object.values(OFFICE_EXTENSIONS).flatMap(extensions =>
    extensions.map(extension => ['.' + extension, 'office'] as const)
  )
])

interface TransferHost {
  selectUpload: (signal: AbortSignal) => Promise<string | AuthorizedArtifactFile | null>
  selectDownload: (name: string) => Promise<string | null>
  progress: (progress: CloudDriveTransferProgress) => void
}

/** 文件名只能作为展示名或原生保存框建议名，不能携带目录和控制字符。 */
function validName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    !!name.trim() &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/:]/.test(name) &&
    !Array.from(name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
}

/** 单文件和批量下载共用相同业务标识边界，不接受本机路径、下载地址或认证信息。 */
function validDownload(value: unknown): boolean {
  const file = value as { assetId?: unknown; name?: unknown; size?: number }

  return (
    !!file &&
    typeof file.assetId === 'string' &&
    !!file.assetId &&
    validName(file.name) &&
    (file.size == null || (Number.isSafeInteger(file.size) && file.size >= 0))
  )
}

/** 原生异常只返回固定状态码，取消和未知写结果不能被改报为成功。 */
function transferFailure(
  error: unknown,
  controller: AbortController,
  upload: boolean
): Exclude<CloudDriveTransferResult, { status: 'succeeded' }> {
  if (error instanceof CloudDriveOperationError && error.result.status !== 'failed') {
    return error.result
  }

  if (controller.signal.aborted) {
    return controller.signal.reason instanceof CloudDriveOperationError
      ? controller.signal.reason.result
      : { status: 'cancelled' }
  }

  if (error instanceof CloudDriveOperationError) {
    return error.result
  }

  const code = (error as NodeJS.ErrnoException)?.code

  return new CloudDriveOperationError(
    'failed',
    upload && code === 'ENOENT'
      ? 'LOCAL_FILE_MISSING'
      : upload && ['EACCES', 'EPERM'].includes(code || '')
        ? 'LOCAL_FILE_READ_FAILED'
        : 'TRANSFER_FAILED'
  ).result
}

/** 大文件使用顺序分片和流式落盘；实际路径只取自主进程核对结果或原生选择框。 */
export class CloudDriveTransfers {
  private readonly active = new Map<number, { id: string; controller: AbortController }>()

  /** 缓存根目录来自当前账号运行时，不接受 Renderer 指定。 */
  constructor(
    private readonly drive: CloudDriveClient,
    private readonly cacheRoot: string,
    private readonly previewOffice?: CloudDriveOfficePreview
  ) {}

  /** 取消仅作用于发起窗口自己的传输。 */
  cancel(owner: number, id?: string): void {
    const transfer = this.active.get(owner)

    if (transfer && (id === undefined || transfer.id === id)) {
      transfer.controller.abort()
    }
  }

  /** 退出账号时终止全部请求，临时文件由各自 finally 清理。 */
  cancelAll(): void {
    for (const transfer of this.active.values()) {
      transfer.controller.abort()
    }
  }

  /** 所有异常转为固定状态码，不跨 IPC 返回账号、认证头或本机路径。 */
  async run(owner: number, input: CloudDriveTransferRequest, host: TransferHost): Promise<CloudDriveTransferResult> {
    if (
      !input ||
      typeof input.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(input.id) ||
      this.active.has(owner) ||
      !['upload', 'download', 'preview', 'download-many'].includes(input.operation) ||
      (input.operation === 'upload'
        ? typeof input.parentAssetId !== 'string' || !input.parentAssetId
        : input.operation === 'download-many'
          ? !Array.isArray(input.assets) ||
            !input.assets.length ||
            input.assets.length > 1000 ||
            !input.assets.every(validDownload)
          : !validDownload(input))
    ) {
      return new CloudDriveOperationError('failed', 'INVALID_ARGUMENT').result
    }

    const controller = new AbortController()
    const checkIdentity = this.drive.guardIdentity()

    const check = () => {
      controller.signal.throwIfAborted()
      checkIdentity()
    }

    const timer = setInterval(() => {
      try {
        checkIdentity()
      } catch {
        controller.abort(new CloudDriveOperationError('failed', 'AUTH_CHANGED'))
      }
    }, 250)

    this.active.set(owner, { id: input.id, controller })

    try {
      check()

      if (input.operation === 'download-many') {
        return await this.downloadBatch(input, host, controller, check)
      }

      return input.operation === 'upload'
        ? await this.upload(input, host, controller.signal, check)
        : await this.download(input, host, controller, check)
    } catch (error) {
      return transferFailure(error, controller, input.operation === 'upload')
    } finally {
      clearInterval(timer)
      this.active.delete(owner)
    }
  }

  /** 批量下载逐项记录真实保存或取消结果，停止后剩余项不会伪装成已保存。 */
  private async downloadBatch(
    input: Extract<CloudDriveTransferRequest, { operation: 'download-many' }>,
    host: TransferHost,
    controller: AbortController,
    check: () => void
  ): Promise<CloudDriveTransferResult> {
    const files: CloudDriveTransferFileResult[] = []

    for (const [index, asset] of input.assets.entries()) {
      let last: CloudDriveTransferProgress = { id: input.id, completed: 0, total: asset.size ?? null }
      const metadata = { name: asset.name, fileIndex: index + 1, fileCount: input.assets.length }

      try {
        check()
        controller.signal.throwIfAborted()

        const result = await this.download(
          { ...asset, operation: 'download', id: input.id },
          {
            ...host,
            progress: progress => {
              last = progress
              host.progress({ ...progress, ...metadata })
            }
          },
          controller,
          check
        )

        files.push({
          index,
          name: asset.name,
          status: result.status,
          ...('code' in result ? { code: result.code } : {})
        })

        if (result.status === 'succeeded' || result.status === 'cancelled') {
          host.progress({ ...last, ...metadata, fileStatus: result.status })
        }
      } catch (error) {
        const failure = transferFailure(error, controller, false)
        files.push({
          index,
          name: asset.name,
          status: failure.status,
          ...('code' in failure ? { code: failure.code } : {})
        })
        files.push(
          ...input.assets
            .slice(index + 1)
            .map((asset, offset) => ({ index: index + offset + 1, name: asset.name, status: 'not_started' as const }))
        )

        return {
          ...(files.some(file => file.status === 'succeeded') && failure.status !== 'cancelled'
            ? new CloudDriveOperationError('partial_success', 'DOWNLOAD_BATCH_PARTIAL').result
            : failure),
          files
        }
      }
    }

    const saved = files.find(file => file.status === 'succeeded')

    return saved ? { status: 'succeeded', name: saved.name, files } : { status: 'cancelled', files }
  }

  /** 用户选中文件后读固定快照，分片失败不自动重发；末片不明确时提示先核对。 */
  private async upload(
    input: Extract<CloudDriveTransferRequest, { operation: 'upload' }>,
    host: TransferHost,
    signal: AbortSignal,
    check: () => void
  ): Promise<CloudDriveTransferResult> {
    const selected = await host.selectUpload(signal)
    check()

    if (!selected) {
      return { status: 'cancelled' }
    }

    const selectedPath = typeof selected === 'string' ? selected : selected.path
    const name = typeof selected === 'string' ? path.basename(selectedPath) : selected.name

    if (!validName(name)) {
      throw new CloudDriveOperationError('failed', 'INVALID_NAME')
    }

    host.progress({ id: input.id, name, completed: 0, total: null })

    const flags = typeof selected !== 'string' ? constants.O_RDONLY | (constants.O_NOFOLLOW || 0) : 'r'
    const file = await open(selectedPath, flags)

    try {
      const snapshot = await file.stat()

      if (
        typeof selected !== 'string' &&
        Object.entries(selected.snapshot).some(
          ([key, value]) => snapshot[key as keyof typeof selected.snapshot] !== value
        )
      ) {
        throw new CloudDriveOperationError('failed', 'FILE_CHANGED')
      }

      const capabilities = (await this.drive.execute({ route: '/drive/capabilities' }, signal)) as {
        upload?: boolean
        max_upload_bytes?: number | null
      }

      check()

      if (!snapshot.isFile() || !Number.isSafeInteger(snapshot.size)) {
        throw new CloudDriveOperationError('failed', 'LOCAL_FILE_READ_FAILED')
      }

      if (!capabilities?.upload) {
        throw new CloudDriveOperationError('failed', 'UPLOAD_NOT_ALLOWED')
      }

      if (capabilities.max_upload_bytes != null && snapshot.size > capabilities.max_upload_bytes) {
        throw new CloudDriveOperationError('failed', 'FILE_TOO_LARGE')
      }

      const totalPart = Math.max(1, Math.ceil(snapshot.size / PART_BYTES))
      const uniqueId = randomUUID().replaceAll('-', '')
      host.progress({ id: input.id, name, completed: 0, total: snapshot.size })

      for (let index = 0; index < totalPart; index++) {
        check()

        const current = await file.stat()

        if (
          current.size !== snapshot.size ||
          current.mtimeMs !== snapshot.mtimeMs ||
          current.ctimeMs !== snapshot.ctimeMs
        ) {
          throw new CloudDriveOperationError('failed', 'FILE_CHANGED')
        }

        const position = index * PART_BYTES
        const bytes = Buffer.alloc(Math.min(PART_BYTES, snapshot.size - position))
        const { bytesRead } = await file.read(bytes, 0, bytes.length, position)

        const afterRead = await file.stat()

        if (
          bytesRead !== bytes.length ||
          afterRead.size !== snapshot.size ||
          afterRead.mtimeMs !== snapshot.mtimeMs ||
          afterRead.ctimeMs !== snapshot.ctimeMs
        ) {
          throw new CloudDriveOperationError('failed', 'FILE_CHANGED')
        }

        check()

        if (index + 1 === totalPart) {
          host.progress({ id: input.id, name, completed: position, total: snapshot.size, phase: 'verifying' })
        }

        try {
          await this.drive.uploadPart(
            {
              uniqueId,
              fileName: name,
              fileSize: snapshot.size,
              totalPart,
              partIndex: index + 1,
              directoryId: input.parentAssetId
            },
            bytes,
            signal
          )
        } catch (error) {
          if (
            index + 1 < totalPart &&
            error instanceof CloudDriveOperationError &&
            error.result.status === 'outcome_unknown'
          ) {
            throw new CloudDriveOperationError('failed', 'UPLOAD_INCOMPLETE')
          }

          throw error
        }

        host.progress({ id: input.id, name, completed: position + bytes.length, total: snapshot.size })
      }

      return { status: 'succeeded', name }
    } finally {
      // 关闭只读句柄失败不能把服务已确认的上传改报为可重试失败。
      await file.close().catch(() => {})
    }
  }

  /** 下载和预览共用完整性校验；临时文件绝不作为成功文件发布。 */
  private async download(
    input: Extract<CloudDriveTransferRequest, { assetId: string }>,
    host: TransferHost,
    controller: AbortController,
    check: () => void
  ): Promise<CloudDriveTransferResult> {
    const preview = input.operation === 'preview'
    const extension = path.extname(input.name).toLowerCase()
    const kind = PREVIEW_KINDS.get(extension)

    if (preview && (!kind || (input.size != null && input.size > PREVIEW_BYTES))) {
      throw new CloudDriveOperationError('failed', kind ? 'PREVIEW_TOO_LARGE' : 'PREVIEW_UNSUPPORTED')
    }

    if (preview && kind === 'office' && !this.previewOffice) {
      throw new CloudDriveOperationError('failed', 'OFFICE_PREVIEW_UNAVAILABLE')
    }

    let directory: string | undefined
    let temporary: string | undefined
    let idle: ReturnType<typeof setTimeout> | undefined

    try {
      let destination: string

      if (preview) {
        await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 })
        const root = await lstat(this.cacheRoot)

        if (!root.isDirectory() || root.isSymbolicLink()) {
          throw new Error('Invalid cache')
        }

        directory = await mkdtemp(path.join(this.cacheRoot, 'preview-'))
        destination = path.join(directory, 'content' + extension)
      } else {
        const selected = await host.selectDownload(input.name)
        check()

        if (!selected) {
          return { status: 'cancelled' }
        }

        destination = selected
      }

      check()
      temporary = path.join(path.dirname(destination), '.drive-' + randomUUID() + '.part')

      const resetIdle = () => {
        clearTimeout(idle)
        idle = setTimeout(() => controller.abort(new CloudDriveOperationError('failed', 'REQUEST_TIMEOUT')), 120_000)
      }

      resetIdle()
      const response = await this.drive.downloadContent(input.assetId, controller.signal)

      if (response.status !== 200 || !response.body) {
        await response.body?.cancel()
        throw new CloudDriveOperationError('failed', 'DOWNLOAD_FAILED')
      }

      const declared = response.headers.get('content-length')
      const length = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null
      const maximum = preview ? PREVIEW_BYTES : Infinity

      if (
        length !== null &&
        (!Number.isSafeInteger(length) || length > maximum || (input.size != null && length !== input.size))
      ) {
        await response.body.cancel()
        throw new CloudDriveOperationError(
          'failed',
          preview && length > maximum ? 'PREVIEW_TOO_LARGE' : 'SIZE_MISMATCH'
        )
      }

      let completed = 0
      const stream = Readable.fromWeb(response.body as ReadableStream)

      /** 每个流块校验身份、长度和预览上限，同时重置空闲计时。 */
      async function* count(source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          check()
          resetIdle()
          completed += chunk.length

          if (completed > maximum || (input.size != null && completed > input.size)) {
            throw new CloudDriveOperationError(
              'failed',
              preview && completed > maximum ? 'PREVIEW_TOO_LARGE' : 'SIZE_MISMATCH'
            )
          }

          host.progress({ id: input.id, completed, total: input.size ?? length })
          yield chunk
        }

        if ((length !== null && completed !== length) || (input.size != null && completed !== input.size)) {
          throw new CloudDriveOperationError('failed', 'SIZE_MISMATCH')
        }
      }

      await pipeline(stream, count, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), {
        signal: controller.signal
      })
      check()
      await rename(temporary, destination)

      if (!preview) {
        return { status: 'succeeded', name: input.name }
      }

      // 下载空闲计时不能截断转换器自己的超时；文件在转换结束前继续由本请求保管。
      clearTimeout(idle)

      if (kind === 'office') {
        host.progress({ id: input.id, completed, total: completed, phase: 'converting' })
        const converted = await this.previewOffice!(destination, controller.signal)
        check()

        return { status: 'succeeded', name: input.name, preview: converted }
      }

      const bytes = await readFile(destination)
      check()
      const mime = kind === 'image' ? IMAGE_MIME[extension] : kind === 'pdf' ? 'application/pdf' : 'text/plain'

      return {
        status: 'succeeded',
        name: input.name,
        preview: { kind: kind!, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
      }
    } finally {
      clearTimeout(idle)

      if (temporary) {
        await rm(temporary, { force: true })
      }

      if (directory) {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
}
