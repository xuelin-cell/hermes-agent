import { atom } from 'nanostores'

import type { Translations } from '@/i18n/types'
import { notify } from '@/store/notifications'

import type {
  CloudDriveArtifactSource,
  CloudDriveTransferProgress,
  CloudDriveTransferRequest,
  CloudDriveTransferResult
} from '../../../electron/login/contract'

import { type DriveTransferRecord, isDriveTransferActive } from './cloud-transfer-copy'
import { announceCloudTransfer } from './cloud-transfer-notifications'
import { beginTransferRecords, finishTransferRecords, progressTransferRecords } from './cloud-transfer-records'

export type TransferInput =
  | { operation: 'upload'; parentAssetId: string; artifact?: CloudDriveArtifactSource }
  | { operation: 'download' | 'preview'; assetId: string; name: string; size?: number | null }
  | { operation: 'download-many'; assets: Array<{ assetId: string; name: string; size?: number | null }> }

interface TransferSnapshot {
  owner: symbol | null
  busy: boolean
  cancelling: boolean
  progress: CloudDriveTransferProgress | null
  result: CloudDriveTransferResult | null
  records: DriveTransferRecord[]
  popupOpen: boolean
  uploadRevision: number
}

interface ActiveTransfer {
  owner: symbol
  request: CloudDriveTransferRequest
  background: boolean
  sawProgress: boolean
  cancelRequested: boolean
  pendingHistory: boolean
  name: string
  copy: Translations
}

/** 每个账号窗口持有控制器；产物上传的请求和订阅不依赖发起页面。 */
export class CloudTransferSession {
  readonly state = atom<TransferSnapshot>({
    owner: null,
    busy: false,
    cancelling: false,
    progress: null,
    result: null,
    records: [],
    popupOpen: false,
    uploadRevision: 0
  })
  private readonly owners = new Set<symbol>()
  private active: ActiveTransfer | null = null
  private unsubscribe: (() => void) | undefined
  private disposed = false

  /** 桥接对象属于固定账号窗口，不能在新账号中复用旧传输。 */
  constructor(readonly bridge: Window['hermesDesktop'] | undefined) {}

  /** 只合并当前窗口的展示状态，不持久化路径或传输内容。 */
  private update(patch: Partial<TransferSnapshot>): void {
    this.state.set({ ...this.state.get(), ...patch })
  }

  /** 桥更换表示窗口账号上下文已失效，旧回执不能通知新窗口。 */
  private current(): boolean {
    if (!this.disposed && this.bridge === window.hermesDesktop) {
      return true
    }
    this.dispose()

    return false
  }

  /** 仍有页面或后台产物任务时才保留唯一进度监听。 */
  private connect(): void {
    this.unsubscribe ??= this.bridge?.onCloudDriveProgress?.(value => {
      const active = this.active

      if (!this.current() || !active || value.id !== active.request.id) {
        return
      }

      if (!value.fileStatus) {
        active.sawProgress = true
      }
      this.update({ progress: value })

      if (active.request.operation !== 'preview') {
        this.revealHistory(active, value.name)
        this.update({ records: progressTransferRecords(this.state.get().records, value) })
      }
    })
  }

  /** 无观察页面且没有后台任务时释放原生订阅，保留纯展示记录供返回查看。 */
  private disconnectIdle(): void {
    if (!this.owners.size && !this.active?.background) {
      this.unsubscribe?.()
      this.unsubscribe = undefined
    }
  }

  /** 页面只登记观察身份，不认领或重启已在运行的上传。 */
  acquire(owner: symbol): void {
    if (!this.current()) {
      return
    }
    this.owners.add(owner)
    this.connect()
  }

  /** 产物上传可跨页面；原有文件选择、下载和预览仍按发起页面离开取消。 */
  release(owner: symbol): void {
    this.owners.delete(owner)

    if (this.active?.owner === owner && !this.active.background) {
      this.cancel()
    }
    this.disconnectIdle()
  }

  /** 原生选文件的首进度到达才创建条目，取消选择不制造上传记录。 */
  private revealHistory(active: ActiveTransfer, name?: string): void {
    if (!active.pendingHistory) {
      return
    }
    active.pendingHistory = false
    this.beginHistory(active.request, name || active.name)
  }

  /** 所有页面共用同一份传输记录，进度入口只由云盘页面渲染。 */
  private beginHistory(request: CloudDriveTransferRequest, name: string): void {
    if (request.operation === 'preview') {
      return
    }
    this.update({ records: beginTransferRecords(this.state.get().records, request, name), popupOpen: true })
  }

  /** 关闭进度浮层只改变展示，不取消传输。 */
  setPopupOpen(open: boolean): void {
    this.update({ popupOpen: open })
  }

  /** 只清理已结束记录；未结束上传必须由用户显式停止。 */
  clearFinished(): void {
    this.update({ records: this.state.get().records.filter(isDriveTransferActive), popupOpen: false })
  }

  /** 停止调用失败时恢复操作入口，不把未取消的任务伪装为已停止。 */
  private cancelFailed(active: ActiveTransfer): void {
    if (!this.current() || this.active !== active) {
      return
    }
    active.cancelRequested = false
    this.update({ cancelling: false })
    notify({
      kind: 'error',
      title: active.copy.cloudLibrary.transfers,
      message: active.copy.cloudLibrary.transferStopFailed
    })
  }

  /** 云盘页面可以停止仍属于其他已关闭页面的产物上传。 */
  cancel(): void {
    const active = this.active

    if (!active || active.cancelRequested || !this.current()) {
      return
    }
    active.cancelRequested = true
    this.update({ cancelling: true })
    const request = this.bridge?.cancelCloudDriveTransfer

    if (!request) {
      this.cancelFailed(active)

      return
    }

    try {
      void Promise.resolve(request(active.request.id)).catch(() => this.cancelFailed(active))
    } catch {
      this.cancelFailed(active)
    }
  }

  /** 原生结果只发布一次；观察页面据修订号刷新目录，关闭页面没有回调残留。 */
  private complete(active: ActiveTransfer, value: CloudDriveTransferResult): void {
    const request = active.request

    const silent =
      value.status === 'cancelled' &&
      !active.sawProgress &&
      !active.cancelRequested &&
      !value.files?.some(file => file.status === 'succeeded')

    this.update({ result: value })

    if (request.operation !== 'preview') {
      if (!silent) {
        this.revealHistory(active, value.status === 'succeeded' ? value.name : undefined)
      }

      if (!active.pendingHistory) {
        this.update({
          records: finishTransferRecords(this.state.get().records, request.id, value, silent),
          ...(silent ? { popupOpen: false } : {})
        })
      }
    }

    if (!silent && (active.background || this.owners.has(active.owner))) {
      announceCloudTransfer(request, value, active.copy)
    }

    if (request.operation === 'upload' && !silent) {
      this.update({ uploadRevision: this.state.get().uploadRevision + 1 })
    }
  }

  /** 捕获源和目标后调用原生传输；共享单次请求锁防止跨页面重复提交。 */
  async start(
    owner: symbol,
    input: TransferInput,
    displayName: string | undefined,
    copy: Translations
  ): Promise<CloudDriveTransferResult | undefined> {
    if (this.active || !this.current()) {
      return
    }
    const request = { ...input, id: crypto.randomUUID() } as CloudDriveTransferRequest

    const active: ActiveTransfer = {
      owner,
      request,
      background: input.operation === 'upload' && !!input.artifact,
      sawProgress: false,
      cancelRequested: false,
      pendingHistory: input.operation === 'upload' && !input.artifact,
      name: displayName || copy.cloudLibrary.upload,
      copy
    }

    this.active = active
    this.connect()

    if (!active.pendingHistory) {
      this.beginHistory(request, active.name)
    }
    this.update({ owner, busy: true, cancelling: false, progress: null, result: null })

    try {
      if (!this.bridge?.cloudDriveTransfer) {
        throw new Error('Bridge unavailable')
      }
      const value = await this.bridge.cloudDriveTransfer(request)

      if (!this.current()) {
        return
      }
      this.complete(active, value)

      return value
    } catch {
      if (!this.current()) {
        return
      }

      const failure = {
        protocol: 'uniwork.drive-result.v1',
        ok: false,
        status: input.operation === 'upload' ? 'outcome_unknown' : 'failed',
        code: 'IPC_ERROR'
      } as const

      this.complete(active, failure)

      return failure
    } finally {
      this.active = null

      if (!this.disposed) {
        this.update({ busy: false, cancelling: false })
      }
      this.disconnectIdle()
    }
  }

  /** 账号桥替换时取消旧请求、释放监听并清空记录，迟到响应不会串到新账号。 */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true

    if (this.active) {
      void Promise.resolve(this.bridge?.cancelCloudDriveTransfer?.(this.active.request.id)).catch(() => {})
    }

    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.owners.clear()
    this.update({ records: [], popupOpen: false, busy: false, result: null, progress: null })
  }
}

let currentSession: CloudTransferSession | undefined

/** 同一账号窗口共享一个任务与历史控制器；替换账号桥时主动释放旧实例。 */
export function cloudTransferSession(): CloudTransferSession {
  const bridge = window.hermesDesktop

  if (!currentSession || currentSession.bridge !== bridge) {
    currentSession?.dispose()
    currentSession = new CloudTransferSession(bridge)
  }

  return currentSession
}
