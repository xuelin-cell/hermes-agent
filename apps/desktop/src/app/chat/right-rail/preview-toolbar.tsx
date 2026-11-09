import { useStore } from '@nanostores/react'
import { createContext, type ReactNode, useContext, useState } from 'react'
import { createPortal } from 'react-dom'

import { ArtifactLibraryUpload, libraryArtifact } from '@/components/chat/artifact-library-upload'
import { useI18n } from '@/i18n'
import { Download, X } from '@/lib/icons'
import { downloadGatewayMediaFile } from '@/lib/media'
import { notifyError } from '@/store/notifications'
import type { PreviewTarget } from '@/store/preview'
import { $activeSessionId, $connection, $selectedStoredSessionId } from '@/store/session'
const Slot = createContext<HTMLElement | null | undefined>(undefined)

export function PreviewToolbarActions({ children }: { children: ReactNode }) {
  const slot = useContext(Slot)

  return slot === undefined ? children : slot ? createPortal(children, slot) : null
}

export function FilePreviewToolbar({
  target,
  onClose,
  children
}: {
  target: PreviewTarget
  onClose?: () => void
  children: ReactNode
}) {
  const { t } = useI18n()
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const [busy, setBusy] = useState(false)
  const connection = useStore($connection)
  const storedSessionId = useStore($selectedStoredSessionId)
  const runtimeSessionId = useStore($activeSessionId)
  const artifact = libraryArtifact(target, storedSessionId || runtimeSessionId, connection)
  const name = (target.label || target.path || target.source).split(/[\\/]/).pop()

  async function download() {
    if (busy) {
      return
    }

    setBusy(true)

    try {
      await downloadGatewayMediaFile(target.path || target.source)
    } catch (error) {
      notifyError(error, t.fileMenu.downloadFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Slot.Provider value={slot}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden" data-file-preview>
        <header className="file-preview-header">
          <span className="file-preview-title" title={target.path || target.source}>
            {name}
          </span>
          <div className="file-preview-actions">
            <div className="file-preview-action-slot" ref={setSlot} />
            <ArtifactLibraryUpload appearance="toolbar" artifact={artifact} />
            <button
              aria-label={t.fileMenu.download}
              className="file-preview-action-btn file-preview-download"
              disabled={busy}
              onClick={() => void download()}
              title={t.fileMenu.download}
              type="button"
            >
              <Download size={16} />
            </button>
            {onClose && (
              <button
                aria-label={t.common.close}
                className="file-preview-action-btn"
                onClick={onClose}
                title={t.common.close}
                type="button"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </Slot.Provider>
  )
}
