import { useEffect, useRef, useState } from 'react'

import { MarkdownPreview } from '@/app/chat/right-rail/preview-file'
import { markdownShareSnapshot } from '@/components/artifact-share/markdown-snapshot'
import { ArtifactShareDialog } from '@/components/artifact-share/share-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { readDesktopFileText } from '@/lib/desktop-fs'

import type { LocalArtifact } from './local-artifact-model'

interface LocalArtifactShareDialogProps {
  file: LocalArtifact
  onClose: () => void
}

/** 列表分享读取原文件后进入统一对话框，准备阶段不会上传或发布。 */
export function LocalArtifactShareDialog({ file, onClose }: LocalArtifactShareDialogProps) {
  const { t } = useI18n()
  const [loaded, setLoaded] = useState<{ text: string } | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const markdown = /\.(mdx?|markdown)$/i.test(file.label)
  const path = file.resolvedPath!

  useEffect(() => {
    let active = true
    setLoaded(null)
    setError('')
    void readDesktopFileText(path)
      .then(result => {
        if (active) {
          if (
            result.binary ||
            result.truncated ||
            (result.byteSize ?? 0) > 2 * 1024 * 1024 ||
            typeof result.text !== 'string'
          ) {
            setError(t.localArtifacts.fileUnavailable)
          } else {
            setLoaded({ text: result.text })
          }
        }
      })
      .catch(error => {
        if (active) {
          setError(error instanceof Error ? error.message : String(error))
        }
      })

    return () => {
      active = false
    }
  }, [path, retry, t.localArtifacts.fileUnavailable])

  /** Markdown 使用与右侧预览相同的渲染器及快照函数，HTML 保留原始完整字节。 */
  function snapshot(): string {
    return markdown ? markdownShareSnapshot(root.current, t.artifactShare) : loaded!.text
  }

  return loaded ? (
    <>
      {markdown && (
        <div aria-hidden="true" className="pointer-events-none absolute -left-[10000px] top-0 w-[800px]" ref={root}>
          <MarkdownPreview filePath={path} text={loaded.text} />
        </div>
      )}
      <ArtifactShareDialog
        artifactKey={`file:${file.sessionId}:${path}`}
        html={snapshot}
        onClose={onClose}
        source={{ sessionId: file.sessionId, path }}
        sourceText={loaded.text}
        title={file.label}
      />
    </>
  ) : (
    <Dialog
      onOpenChange={open => {
        if (!open) {
          onClose()
        }
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.artifactShare.shareArtifact}</DialogTitle>
          <DialogDescription>{file.label}</DialogDescription>
        </DialogHeader>
        {error ? (
          <>
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
            <Button onClick={() => setRetry(value => value + 1)}>{t.common.retry}</Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            {t.artifactShare.checking}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
