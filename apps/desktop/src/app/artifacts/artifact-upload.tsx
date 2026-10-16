import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { isBrowserShell } from '@/lib/browser-shell'
import { RefreshCw } from '@/lib/icons'
import { isArtifactFilePath } from '@/lib/media'
import { cn } from '@/lib/utils'
import { $connection } from '@/store/session'

import type { ArtifactRecord } from './artifact-utils'
import { CloudTransferFeedback } from './cloud-transfer-feedback'
import { driveFolderPath } from './drive-directory-index'
import { DriveFolderPicker } from './drive-folder-picker'
import { useCloudLibraryData } from './use-cloud-library-data'
import { useCloudTransfer } from './use-cloud-transfer'

/** 本机产物才开放上传入口，网络图片、链接和其他连接的路径不冒充本机文件。 */
export function canUploadArtifact(artifact: ArtifactRecord, mode?: string): boolean {
  return (
    !isBrowserShell() &&
    mode === 'local' &&
    (!artifact.connectionId || artifact.connectionId === 'local') &&
    artifact.kind !== 'link' &&
    (isArtifactFilePath(artifact.value) || /^file:\/\//i.test(artifact.value))
  )
}

interface ArtifactUploadActionProps {
  artifact: ArtifactRecord
  onSelect: (artifact: ArtifactRecord) => void
}

/** 叶子只展示选择按钮，不为列表里的每一个文件创建传输订阅。 */
export function ArtifactUploadAction({ artifact, onSelect }: ArtifactUploadActionProps) {
  const connection = useStore($connection)
  const { t } = useI18n()

  if (!canUploadArtifact(artifact, connection?.mode)) {
    return null
  }

  return (
    <Button
      aria-label={`${t.cloudLibrary.uploadArtifact} · ${artifact.label}`}
      onClick={() => onSelect(artifact)}
      size="xs"
      variant="ghost"
    >
      {t.cloudLibrary.uploadArtifact}
    </Button>
  )
}

interface ArtifactUploadDialogProps {
  artifact: ArtifactRecord
  onClose: () => void
  onUploaded?: () => void
}

/** 选好云盘目录后直接上传已核对的产物，不要求用户再次从本机文件框寻找它。 */
export function ArtifactUploadDialog({ artifact, onClose, onUploaded }: ArtifactUploadDialogProps) {
  const { t } = useI18n()
  const copy = t.cloudLibrary
  const connection = useStore($connection)
  const { space, capabilities, snapshot, error, refresh } = useCloudLibraryData()
  const transfer = useCloudTransfer(refresh)
  const refreshing = snapshot.scanning || (!space && !error)
  const reported = useRef(false)
  // reported 是一次性完成通知锁，不是响应式值的镜像。
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (transfer.result?.status === 'succeeded' && !reported.current) {
      reported.current = true
      onUploaded?.()
    }
  }, [transfer.result, onUploaded])
  const [selected, setSelected] = useState('')
  const parent = selected || space?.root_asset_id || ''
  const path = space && driveFolderPath(snapshot.items, space.root_asset_id, parent)
  const target = snapshot.items.find(item => item.asset_id === parent)

  const terminal =
    transfer.result && ['succeeded', 'partial_success', 'outcome_unknown'].includes(transfer.result.status)

  const canUpload =
    canUploadArtifact(artifact, connection?.mode) &&
    !!space &&
    !!capabilities?.upload &&
    path !== null &&
    target?.permissions?.write !== false &&
    !transfer.busy &&
    !terminal

  /** 关闭弹窗会卸载传输控制器，原生端同步取消未结束的请求。 */
  function close(): void {
    onClose()
  }

  /** 文件源和目标一起捕获，后续切换目录不改变已经开始的上传。 */
  function submit(): void {
    if (!canUpload) {
      return
    }

    void transfer.start(
      {
        operation: 'upload',
        parentAssetId: parent,
        artifact: {
          sessionId: artifact.sessionId,
          profile: artifact.profile || 'default',
          connectionId: artifact.connectionId,
          value: artifact.value
        }
      },
      artifact.label
    )
  }

  return (
    <Dialog
      onOpenChange={open => {
        if (!open) {
          close()
        }
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-1">
            <DialogTitle>{copy.uploadArtifact}</DialogTitle>
            <Tip label={copy.refresh}>
              <Button
                aria-busy={refreshing}
                aria-label={copy.refresh}
                disabled={transfer.busy || refreshing}
                onClick={refresh}
                size="icon-sm"
                variant="ghost"
              >
                <RefreshCw aria-hidden="true" className={cn(refreshing && 'animate-spin')} />
              </Button>
            </Tip>
          </div>
          <DialogDescription>
            {copy.chooseUploadFolder} · {artifact.label}
          </DialogDescription>
        </DialogHeader>
        {space && (
          <DriveFolderPicker
            complete={snapshot.complete}
            disabled={transfer.busy || !!terminal}
            emptyHint={copy.noUploadSubfolders}
            items={snapshot.items}
            onNavigate={setSelected}
            parent={parent}
            path={path}
            root={space.root_asset_id}
            showPartialHint={false}
          />
        )}
        {!space && !error && <p role="status">{t.common.loading}</p>}
        {(error || snapshot.error || (space && !capabilities)) && (
          <p role="alert">
            {copy.artifactCloudUnavailable}
            <Button disabled={transfer.busy} onClick={refresh} size="sm" variant="ghost">
              {copy.refresh}
            </Button>
          </p>
        )}
        {snapshot.scanning && !snapshot.items.length && !snapshot.loadedDirectories.length && (
          <p className="text-sm text-muted-foreground">{copy.loading}</p>
        )}
        {!canUploadArtifact(artifact, connection?.mode) && <p role="alert">{copy.artifactRemote}</p>}
        <DialogFooter>
          <CloudTransferFeedback transfer={transfer} />
          <Button onClick={close} variant="ghost">
            {terminal ? t.common.close : t.common.cancel}
          </Button>
          <Button disabled={!canUpload} onClick={submit}>
            {copy.uploadHere}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
