import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { usePreparePreview } from '@/app/chat/right-rail/formats/prepare'
import { useSessionView } from '@/app/chat/session-view'
import { useI18n } from '@/i18n'
import { Download, FileText } from '@/lib/icons'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { downloadGatewayMediaFile } from '@/lib/media'
import { previewName } from '@/lib/preview-targets'
import { notifyError } from '@/store/notifications'
import { $previewTabSources, closePreviewForSource, openPreview } from '@/store/preview'

const ACTION_CLASS =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-(--ui-stroke-tertiary) bg-background px-3 text-xs font-medium text-foreground/80 transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground disabled:opacity-50'

export function PreviewAttachment({ target }: { target: string }) {
  const { t } = useI18n()
  // This link lives in one session's transcript; resolve it against THAT
  // session's cwd, not the primary chat's.
  const cwd = useStore(useSessionView().$cwd)
  usePreparePreview(target, cwd)
  const openSources = useStore($previewTabSources)
  const [opening, setOpening] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const cwdRef = useRef(cwd)
  const mountedRef = useRef(false)
  const requestTokenRef = useRef(0)
  const targetRef = useRef(target)
  const name = previewName(target)
  const isActive = openSources.includes(target)

  cwdRef.current = cwd
  targetRef.current = target

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      requestTokenRef.current += 1
    }
  }, [])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    requestTokenRef.current += 1
    setOpening(false)
  }, [cwd, target])

  async function togglePreview() {
    if (opening) {
      return
    }

    if (isActive) {
      closePreviewForSource(target)

      return
    }

    const requestToken = ++requestTokenRef.current
    const requestTarget = target
    const requestCwd = cwd

    setOpening(true)

    try {
      const preview = await normalizeOrLocalPreviewTarget(requestTarget, requestCwd || undefined)

      if (
        !mountedRef.current ||
        requestTokenRef.current !== requestToken ||
        targetRef.current !== requestTarget ||
        cwdRef.current !== requestCwd
      ) {
        return
      }

      if (!preview) {
        throw new Error(`Could not open preview target: ${requestTarget}`)
      }

      openPreview(preview)
    } catch (error) {
      if (
        !mountedRef.current ||
        requestTokenRef.current !== requestToken ||
        targetRef.current !== requestTarget ||
        cwdRef.current !== requestCwd
      ) {
        return
      }

      notifyError(error, t.preview.unavailable)
    } finally {
      if (mountedRef.current && requestTokenRef.current === requestToken) {
        setOpening(false)
      }
    }
  }

  async function downloadFile() {
    if (downloading) {
      return
    }

    setDownloading(true)

    try {
      // Works in both modes: the Electron main process fetches the bytes
      // through the session's backend connection (local gateway or remote)
      // and prompts for a save location.
      const result = await downloadGatewayMediaFile(target)

      if (mountedRef.current && result.saved) {
        setDownloaded(true)
        setTimeout(() => mountedRef.current && setDownloaded(false), 2000)
      }
    } catch (error) {
      if (mountedRef.current) {
        notifyError(error, t.fileMenu.downloadFailed)
      }
    } finally {
      if (mountedRef.current) {
        setDownloading(false)
      }
    }
  }

  return (
    // 窄窗时操作按钮整体换到第二行，文件名保留整行宽度。
    <span className="flex w-full max-w-160 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-(--ui-stroke-tertiary) bg-background px-3.5 py-2.5 text-sm transition-colors hover:bg-muted/50">
      <span className="flex min-w-0 flex-1 basis-48 items-center gap-3">
        <span className="grid size-6 shrink-0 place-items-center text-muted-foreground">
          <FileText className="size-5" />
        </span>
        <span className="min-w-0 flex-1" title={target}>
          <span className="block truncate text-sm font-medium leading-5 text-foreground">{name}</span>
          <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
            {name.includes('.') ? name.split('.').pop()?.toUpperCase() : 'FILE'}
          </span>
        </span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          aria-label={t.fileMenu.download}
          className={ACTION_CLASS}
          disabled={downloading}
          onClick={() => void downloadFile()}
          type="button"
        >
          <Download className="size-3.5" />
          {downloaded ? t.fileMenu.downloadSaved : t.fileMenu.download}
        </button>
        <button className={ACTION_CLASS} disabled={opening} onClick={() => void togglePreview()} type="button">
          {opening ? t.preview.opening : isActive ? t.preview.hide : t.preview.openPreview}
        </button>
      </span>
    </span>
  )
}
