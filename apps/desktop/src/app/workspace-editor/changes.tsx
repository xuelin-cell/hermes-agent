import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import type { HermesReviewFile } from '@/global'
import { useI18n } from '@/i18n'
import { desktopGitRoot } from '@/lib/desktop-fs'
import { desktopGit } from '@/lib/desktop-git'
import { $workspaceChangeTick } from '@/store/workspace-events'

interface EditorChangesProps {
  cwd: string
  refresh: number
  onDiff: (root: string, file: HermesReviewFile) => void
}

export function EditorChanges({ cwd, refresh, onDiff }: EditorChangesProps) {
  const { t } = useI18n()
  const tick = useStore($workspaceChangeTick)
  const [files, setFiles] = useState<HermesReviewFile[]>([])
  const [root, setRoot] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)

    void (async () => {
      try {
        const repo = await desktopGitRoot(cwd)

        if (!active) {
          return
        }

        setRoot(repo)
        const git = desktopGit()

        if (!repo || !git) {
          setFiles([])

          return
        }

        const result = await git.review.list(repo, 'uncommitted')

        if (active) {
          setFiles(result.files)
        }
      } catch (cause) {
        if (active) {
          setError(String(cause instanceof Error ? cause.message : cause))
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    })()

    return () => {
      active = false
    }
  }, [cwd, refresh, tick])

  return (
    <section className="min-h-0 flex-1 overflow-auto border-t border-(--ui-stroke-tertiary) p-2">
      <div className="flex items-center gap-2 py-2 text-xs font-medium">
        <Codicon name="git-compare" />
        {t.sidebar.review}
        <span>{files.length}</span>
      </div>
      {loading ? (
        <p role="status">{t.sidebar.loading}</p>
      ) : error ? (
        <p className="break-all text-xs" role="alert">
          {error}
        </p>
      ) : !root ? (
        <p className="text-xs">{t.statusStack.coding.notRepo}</p>
      ) : !files.length ? (
        <p className="text-xs">{t.statusStack.coding.noChanges}</p>
      ) : (
        files.map(file => (
          <button
            className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-sm hover:bg-(--ui-row-hover-background)"
            key={`${file.path}:${file.staged}`}
            onClick={() => {
              if (root) {
                onDiff(root, file)
              }
            }}
            type="button"
          >
            <span>{file.status}</span>
            <span className="truncate">{file.path}</span>
          </button>
        ))
      )}
    </section>
  )
}
