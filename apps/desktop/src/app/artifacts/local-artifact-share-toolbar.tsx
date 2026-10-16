import { useEffect, useMemo, useRef, useState } from 'react'

import { MarkdownPreview } from '@/app/chat/right-rail/preview-file'
import { markdownShareSnapshot } from '@/components/artifact-share/markdown-snapshot'
import { ShareControls } from '@/components/artifact-share/share-controls'
import { useI18n } from '@/i18n'
import { readDesktopFileText } from '@/lib/desktop-fs'
import { notifyError } from '@/store/notifications'

import type { LocalArtifact } from './local-artifact-model'

interface LocalArtifactShareToolbarProps {
  file: LocalArtifact
  onOpen: () => void
  onClose: () => void
}

/** 列表点击先读取原文件，未发布时只发布，已有链接才显示操作工具栏。 */
export function LocalArtifactShareToolbar({ file, onOpen, onClose }: LocalArtifactShareToolbarProps) {
  const { t } = useI18n()
  const [loaded, setLoaded] = useState<{ text: string } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const markdown = /\.(mdx?|markdown)$/i.test(file.label)
  const path = file.resolvedPath!
  const listAction = useMemo(() => ({ onOpen, onClose }), [onOpen, onClose])

  useEffect(() => {
    let active = true
    setLoaded(null)
    void readDesktopFileText(path)
      .then(result => {
        if (active) {
          if (
            result.binary ||
            result.truncated ||
            (result.byteSize ?? 0) > 2 * 1024 * 1024 ||
            typeof result.text !== 'string'
          ) {
            notifyError(new Error(t.localArtifacts.fileUnavailable), t.artifactShare.shareFailed)
            onClose()
          } else {
            setLoaded({ text: result.text })
          }
        }
      })
      .catch(error => {
        if (active) {
          notifyError(error, t.artifactShare.shareFailed)
          onClose()
        }
      })

    return () => {
      active = false
    }
  }, [path, onClose, t.localArtifacts.fileUnavailable, t.artifactShare.shareFailed])

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
      <ShareControls
        artifactKey={`file:${file.sessionId}:${path}`}
        html={snapshot}
        listAction={listAction}
        source={{ sessionId: file.sessionId, path }}
        sourceText={loaded.text}
        title={file.label}
      />
    </>
  ) : null
}
