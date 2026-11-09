import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { ImageLightbox } from '@/components/chat/zoomable-image'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useImageDownload } from '@/hooks/use-image-download'
import { useI18n } from '@/i18n'
import { readDesktopFileDataUrl, readDesktopFileDataUrlLocalFirst } from '@/lib/desktop-fs'
import { AlertCircle, FileText, FolderOpen, ImageIcon, Link, Loader2, Terminal } from '@/lib/icons'
import { downscaleDataUrlForPreview, FALLBACK_PLACEHOLDER } from '@/lib/image-resize'
import { localPreviewTarget, normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { cn } from '@/lib/utils'
import type { ComposerAttachment } from '@/store/composer'
import { notifyError } from '@/store/notifications'
import { openPreview } from '@/store/preview'

export function AttachmentList({
  attachments,
  onRemove,
  tiles = false
}: {
  attachments: ComposerAttachment[]
  onRemove?: (id: string) => void
  tiles?: boolean
}) {
  return (
    <div
      className={cn('flex max-w-full flex-wrap gap-2', tiles ? 'items-start pb-2' : 'px-1 pt-1.5')}
      data-slot="composer-attachments"
    >
      {attachments.filter(Boolean).map(attachment => (
        <AttachmentPill
          attachment={attachment}
          key={attachment.occurrenceId ? `occ:${attachment.occurrenceId}` : attachment.id}
          onRemove={onRemove}
          tile={tiles}
        />
      ))}
    </div>
  )
}

function AttachmentPill({
  attachment,
  onRemove,
  tile
}: {
  attachment: ComposerAttachment
  onRemove?: (id: string) => void
  tile: boolean
}) {
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

  const imageTarget =
    tile && attachment.kind === 'image' && attachment.path ? localPreviewTarget(attachment.path, cwd) : null

  const imagePath = imageTarget?.kind === 'file' ? imageTarget.path : undefined
  const [tileThumbnail, setTileThumbnail] = useState<{ path: string; url: string }>()
  const [failedThumbnail, setFailedThumbnail] = useState<string>()

  // 卡片只保留缩略图，点击时再从原附件位置读取完整图片。
  useEffect(() => {
    if (!imagePath) {
      return
    }

    let active = true
    void readDesktopFileDataUrl(imagePath)
      .then(url => (url ? downscaleDataUrlForPreview(url) : undefined))
      .then(url => {
        if (active && url && url !== FALLBACK_PLACEHOLDER) {
          setTileThumbnail({ path: imagePath, url })
        }
      })
      .catch(() => undefined)

    return () => {
      active = false
    }
  }, [imagePath])

  const thumbnail =
    attachment.thumbnailUrl ||
    attachment.previewUrl ||
    (tileThumbnail && tileThumbnail.path === imagePath ? tileThumbnail.url : undefined)

  const showThumbnail = attachment.kind === 'image' && thumbnail && (!tile || thumbnail !== failedThumbnail)
  const filename = attachment.path?.split(/[\\/]/).at(-1) || attachment.label
  const extension = filename.match(/\.([a-z0-9]{1,8})$/i)?.[1].toUpperCase()

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
        if (!source && imagePath) {
          source = await readDesktopFileDataUrl(imagePath)
        } else if (!source) {
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
        <div
          className={cn('group/attachment relative min-w-0 max-w-full shrink-0', tile ? 'size-[92px]' : 'w-60')}
          data-slot={tile ? 'message-attachment-tile' : undefined}
        >
          <button
            aria-busy={isUploading || undefined}
            aria-label={canPreview ? c.previewLabel(attachment.label) : attachment.label}
            className={cn(
              'flex h-full w-full rounded-xl border text-left transition-colors disabled:cursor-default',
              tile
                ? 'relative justify-center overflow-hidden bg-muted/60'
                : 'items-center gap-2.5 bg-background px-2.5 py-2',
              hasUploadError
                ? 'border-destructive/45 bg-destructive/5 hover:border-destructive/60'
                : 'border-(--ui-stroke-tertiary) enabled:hover:border-(--ui-stroke-secondary) enabled:hover:bg-(--chrome-action-hover)'
            )}
            disabled={!canPreview}
            onClick={() => void openAttachment()}
            type="button"
          >
            <span
              className={cn(
                'relative grid shrink-0 place-items-center overflow-hidden text-muted-foreground',
                tile
                  ? 'size-full pb-3'
                  : 'size-9 rounded-lg bg-muted/60 transition-colors group-hover/attachment:bg-background'
              )}
            >
              {showThumbnail ? (
                <img
                  alt={attachment.label}
                  className={cn('size-full object-cover', tile && 'absolute inset-0')}
                  draggable={false}
                  onError={tile ? () => setFailedThumbnail(thumbnail) : undefined}
                  src={thumbnail}
                />
              ) : (
                <Icon className={tile ? 'size-5' : 'size-4.5'} />
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
            {tile ? (
              <span
                className={cn(
                  'pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-start gap-0.5 px-1.5 pb-1.5 pt-2',
                  showThumbnail && 'bg-gradient-to-t from-black/80 to-transparent text-white'
                )}
              >
                {extension && (
                  <span className="rounded-sm bg-black/65 px-1 text-[9px] font-bold text-white">{extension}</span>
                )}
                <span className="block max-w-full truncate text-[11px] leading-4" title={attachment.label}>
                  {attachment.label}
                </span>
              </span>
            ) : (
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
            )}
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
