import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { isBrowserShell } from '@/lib/browser-shell'
import { FolderOpen } from '@/lib/icons'
import { isArtifactFilePath } from '@/lib/media'
import { $connection } from '@/store/session'

import type { ArtifactRecord } from './artifact-utils'
import { CloudTransferFeedback } from './cloud-transfer-feedback'
import { DriveBreadcrumbs } from './drive-breadcrumbs'
import { driveFolderPath } from './drive-directory-index'
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

/** 叶子只展示选择按钮，不为列表里的每一个文件创建传输订阅。 */
export function ArtifactUploadAction({
  artifact,
  onSelect
}: {
  artifact: ArtifactRecord
  onSelect: (artifact: ArtifactRecord) => void
}) {
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

/** 选好云盘目录后直接上传已核对的产物，不要求用户再次从本机文件框寻找它。 */
export function ArtifactUploadDialog({ artifact, onClose }: { artifact: ArtifactRecord; onClose: () => void }) {
  const { t } = useI18n()
  const copy = t.cloudLibrary
  const connection = useStore($connection)
  const { space, capabilities, snapshot, error, refresh } = useCloudLibraryData()
  const transfer = useCloudTransfer(refresh)
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

  const children = snapshot.items
    .filter(item => item.kind === 'directory' && item.parent_asset_id === parent && item.permissions?.read !== false)
    .sort((left, right) => left.name.localeCompare(right.name))

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
          <DialogTitle>{copy.uploadArtifact}</DialogTitle>
          <DialogDescription>
            {artifact.label} · {artifact.sessionTitle}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{copy.chooseUploadFolder}</p>
        {space && (
          <>
            <DriveBreadcrumbs
              disabled={transfer.busy || !!terminal}
              onNavigate={setSelected}
              path={path || []}
              root={space.root_asset_id}
            />
            <div aria-label={copy.destination} className="max-h-64 overflow-y-auto" role="region">
              {children.map(folder => (
                <Button
                  className="flex w-full justify-start"
                  disabled={transfer.busy || !!terminal}
                  key={folder.asset_id}
                  onClick={() => setSelected(folder.asset_id)}
                  variant="ghost"
                >
                  <FolderOpen />
                  {folder.name}
                </Button>
              ))}
            </div>
          </>
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
            {t.common.close}
          </Button>
          <Button disabled={!canUpload} onClick={submit}>
            {copy.uploadHere}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
