import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { $apiRequestScope } from '@/api/client'
import { ArtifactUploadDialog, canUploadArtifact } from '@/app/artifacts/artifact-upload'
import type { ArtifactRecord } from '@/app/artifacts/artifact-utils'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import type { HermesConnection } from '@/global'
import { useI18n } from '@/i18n'
import { CloudUpload } from '@/lib/icons'
import { localPreviewTarget } from '@/lib/local-preview'
import { previewShareSource } from '@/lib/preview-share-source'
import type { PreviewTarget } from '@/store/preview'
import { $connection } from '@/store/session'

/** 沿用显式来源；云盘预览和不匹配的 Profile 不能借用当前会话上传。 */
export function libraryArtifact(
  target: PreviewTarget,
  sessionId: string | null,
  connection: HermesConnection | null
): ArtifactRecord | null {
  const source = previewShareSource(target, connection)
  const id = source === undefined ? sessionId : source?.sessionId
  const path = source?.path || target.path || target.source

  if (!id || source === null || target.kind !== 'file' || !localPreviewTarget(path)?.path) {
    return null
  }

  const artifact: ArtifactRecord = {
    id: `${id}:${path}`,
    kind: 'file',
    value: path,
    href: target.url,
    label: target.label,
    sessionId: id,
    profile: connection?.profile || 'default',
    connectionId: 'local',
    sessionTitle: '',
    timestamp: 0
  }

  return canUploadArtifact(artifact, connection?.mode) ? artifact : null
}

interface ArtifactLibraryUploadProps {
  artifact: ArtifactRecord | null
  appearance?: 'card' | 'toolbar'
}

/** 弹窗只在点击后挂载；来源变化关闭旧弹窗，已发起任务仍由窗口继续执行。 */
export function ArtifactLibraryUpload(props: ArtifactLibraryUploadProps) {
  const scope = useStore($apiRequestScope)
  const connection = useStore($connection)

  if (!props.artifact || !canUploadArtifact(props.artifact, connection?.mode)) {
    return null
  }

  return <ScopedUpload {...props} artifact={props.artifact} key={JSON.stringify([scope, props.artifact])} />
}

/** 卡片和预览工具栏都只显示云朵上传图标，文案放在悬停提示里，共用同一个上传弹窗。 */
function ScopedUpload({ artifact, appearance = 'card' }: ArtifactLibraryUploadProps & { artifact: ArtifactRecord }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const label = t.cloudLibrary.uploadToLibrary

  return (
    <>
      <Tip label={label}>
        <Button
          aria-label={label}
          onClick={() => setOpen(true)}
          size="icon-sm"
          type="button"
          variant={appearance === 'toolbar' ? 'ghost' : 'outline'}
        >
          <CloudUpload aria-hidden="true" className={appearance === 'card' ? 'size-4' : undefined} />
        </Button>
      </Tip>
      {open && (
        <ArtifactUploadDialog artifact={artifact} onClose={() => setOpen(false)} onSubmitted={() => setOpen(false)} />
      )}
    </>
  )
}
