import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { $apiRequestScope } from '@/api/client'
import { ArtifactUploadDialog, canUploadArtifact } from '@/app/artifacts/artifact-upload'
import type { ArtifactRecord } from '@/app/artifacts/artifact-utils'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import type { HermesConnection } from '@/global'
import { useI18n } from '@/i18n'
import { Upload } from '@/lib/icons'
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

/** 弹窗只在点击后挂载，来源或账号改变时丢弃旧传输控制器。 */
export function ArtifactLibraryUpload(props: ArtifactLibraryUploadProps) {
  const scope = useStore($apiRequestScope)
  const connection = useStore($connection)

  if (!props.artifact || !canUploadArtifact(props.artifact, connection?.mode)) {
    return null
  }

  return <ScopedUpload {...props} artifact={props.artifact} key={JSON.stringify([scope, props.artifact])} />
}

/** 卡片显示文字，预览工具栏使用带提示的图标，共用同一个上传弹窗。 */
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
          size={appearance === 'toolbar' ? 'icon-sm' : 'sm'}
          type="button"
          variant={appearance === 'toolbar' ? 'ghost' : 'outline'}
        >
          <Upload aria-hidden="true" />
          {appearance === 'card' && label}
        </Button>
      </Tip>
      {open && <ArtifactUploadDialog artifact={artifact} onClose={() => setOpen(false)} />}
    </>
  )
}
