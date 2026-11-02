import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { ImageLightbox } from '@/components/chat/zoomable-image'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useImageDownload } from '@/hooks/use-image-download'
import { useI18n } from '@/i18n'
import { readDesktopFileDataUrlLocalFirst } from '@/lib/desktop-fs'
import { AlertCircle, FileText, FolderOpen, ImageIcon, Link, Loader2, Terminal } from '@/lib/icons'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { cn } from '@/lib/utils'
import type { ComposerAttachment } from '@/store/composer'
import { notifyError } from '@/store/notifications'
import { openPreview } from '@/store/preview'

export function AttachmentList({
  attachments,
  onRemove
}: {
  attachments: ComposerAttachment[]
  onRemove?: (id: string) => void
}) {
  return (
    <div className="flex max-w-full flex-wrap gap-2 px-1 pt-1.5" data-slot="composer-attachments">
      {attachments.filter(Boolean).map(attachment => (
        <AttachmentPill
          attachment={attachment}
          key={attachment.occurrenceId ? `occ:${attachment.occurrenceId}` : attachment.id}
          onRemove={onRemove}
        />
      ))}
    </div>
  )
}

function AttachmentPill({ attachment, onRemove }: { attachment: ComposerAttachment; onRemove?: (id: string) => void }) {
  const { t } = useI18n()
  const c = t.composer

  const Icon = {
    file: FileText,
    folder: FolderOpen,
    image: ImageIcon,
    terminal: Terminal,
    url: Link
  }[attachment.kind]

  // The tile's cwd when this pill lives in a tile composer, not the primary's:
  // a relative attachment path has to resolve against its own session's root.
  const cwd = useStore(useSessionView().$cwd)
  const isUploading = attachment.uploadState === 'uploading'
  const hasUploadError = attachment.uploadState === 'error'

  const canPreview =
    !attachment.cloudAssetId && attachment.kind !== 'folder' && attachment.kind !== 'terminal' && !isUploading

  const detail = attachment.cloudAssetId
    ? t.cloudLibrary.personal
    : attachment.detail && attachment.detail !== attachment.label
      ? attachment.detail
      : undefined

  // Keep full image bytes out of composer state. New chips read their path only
  // when clicked; previewUrl remains a compatibility fallback for older drafts.
  const [loadedImageSrc, setLoadedImageSrc] = useState<string>()
  const lightboxSrc = attachment.kind === 'image' && !isUploading ? attachment.previewUrl || loadedImageSrc : undefined
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const { download, saving } = useImageDownload(lightboxSrc)

  async function openAttachment() {
    if (!canPreview) {
      return
    }

    if (attachment.kind === 'image') {
      try {
        let source = lightboxSrc || ''

        // Upload may replace `path` with a gateway-side staged path while
        // `detail` still carries the original host path. If submit then fails,
        // keep the surviving chip previewable across split-filesystem setups.
        if (!source) {
          const paths = [attachment.path, attachment.detail].filter(
            (path, index, candidates): path is string => Boolean(path) && candidates.indexOf(path) === index
          )

          let lastError: unknown

          for (const path of paths) {
            try {
              source = await readDesktopFileDataUrlLocalFirst(path)

              if (source) {
                break
              }
            } catch (error) {
              lastError = error
            }
          }

          if (!source && lastError) {
            throw lastError
          }
        }

        if (!source) {
          throw new Error(c.couldNotPreview(attachment.label))
        }

        setLoadedImageSrc(source)
        setLightboxOpen(true)
      } catch (error) {
        notifyError(error, c.previewUnavailable)
      }

      return
    }

    const rawTarget =
      attachment.path ||
      attachment.detail ||
      attachment.refText?.replace(/^@(file|image|url):/, '') ||
      attachment.label ||
      ''

    const target = rawTarget.replace(/^`|`$/g, '')

    if (!target) {
      return
    }

    try {
      const preview = await normalizeOrLocalPreviewTarget(target, cwd || undefined)

      if (!preview) {
        throw new Error(c.couldNotPreview(attachment.label))
      }

      openPreview(preview)
    } catch (error) {
      notifyError(error, c.previewUnavailable)
    }
  }

  return (
    <>
      <Tip
        label={
          attachment.cloudAssetId
            ? `${t.cloudLibrary.personal} · ${attachment.label}`
            : attachment.path || attachment.detail || attachment.label
        }
      >
        <div className="group/attachment relative w-60 min-w-0 max-w-full shrink-0">
          <button
            aria-busy={isUploading || undefined}
            aria-label={canPreview ? c.previewLabel(attachment.label) : attachment.label}
            className={cn(
              'flex h-full w-full items-center gap-2.5 rounded-xl border bg-background px-2.5 py-2 text-left transition-colors disabled:cursor-default',
              hasUploadError
                ? 'border-destructive/45 bg-destructive/5 hover:border-destructive/60'
                : 'border-(--ui-stroke-tertiary) enabled:hover:border-(--ui-stroke-secondary) enabled:hover:bg-(--chrome-action-hover)'
            )}
            disabled={!canPreview}
            onClick={() => void openAttachment()}
            type="button"
          >
            <span className="relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted/60 text-muted-foreground transition-colors group-hover/attachment:bg-background">
              {(attachment.thumbnailUrl || attachment.previewUrl) && attachment.kind === 'image' ? (
                <img
                  alt={attachment.label}
                  className="size-full object-cover"
                  draggable={false}
                  src={attachment.thumbnailUrl ?? attachment.previewUrl}
                />
              ) : (
                <Icon className="size-4.5" />
              )}
              {isUploading && (
                <span className="absolute inset-0 grid place-items-center bg-background/60 backdrop-blur-[1px]">
                  <Loader2 className="size-4 animate-spin text-foreground/75" />
                </span>
              )}
              {hasUploadError && (
                <span className="absolute inset-0 grid place-items-center bg-destructive/15">
                  <AlertCircle className="size-4 text-destructive" />
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-[0.8125rem] font-medium leading-5 text-foreground wrap-anywhere">
                {attachment.label}
              </span>
              {detail && (
                <span
                  className={cn(
                    'mt-0.5 block truncate text-xs leading-4',
                    hasUploadError ? 'text-destructive/80' : 'text-muted-foreground'
                  )}
                >
                  {detail}
                </span>
              )}
            </span>
          </button>
          {onRemove && (
            <button
              aria-label={c.removeAttachment(attachment.label)}
              className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-(--ui-stroke-secondary) bg-background text-muted-foreground opacity-0 shadow-xs transition hover:bg-(--chrome-action-hover) hover:text-foreground group-hover/attachment:opacity-100 focus-visible:opacity-100"
              onClick={() => onRemove(attachment.id)}
              type="button"
            >
              <Codicon name="close" size="0.75rem" />
            </button>
          )}
        </div>
      </Tip>
      {lightboxSrc && (
        <ImageLightbox
          alt={attachment.label}
          copy={t.desktop}
          onClick={download}
          onOpenChange={open => {
            setLightboxOpen(open)

            if (!open && !attachment.previewUrl) {
              setLoadedImageSrc(undefined)
            }
          }}
          open={lightboxOpen}
          saving={saving}
          src={lightboxSrc}
        />
      )}
    </>
  )
}
