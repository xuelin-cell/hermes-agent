import { useStore } from '@nanostores/react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'

import { FileDiffPanel } from '@/components/chat/diff-lines'
import { Button } from '@/components/ui/button'
import type { HermesReviewFile } from '@/global'
import { useI18n } from '@/i18n'
import { desktopFsCacheKey } from '@/lib/desktop-fs'
import { desktopGit } from '@/lib/desktop-git'
import { $connection, $currentCwd, $selectedStoredSessionId, $workspaceCwdOwner } from '@/store/session'
import { $workspaceChangeTick } from '@/store/workspace-events'

import { EditorChanges } from './changes'
import { EditorFileTree } from './file-tree'
import { useEditorDocument } from './use-editor-document'

const CodeEditor = lazy(async () => ({ default: (await import('@/components/chat/code-editor')).CodeEditor }))

export function WorkspaceEditor() {
  const { t } = useI18n()
  const connection = useStore($connection)
  const cwd = useStore($currentCwd)
  const owner = useStore($workspaceCwdOwner)
  const selected = useStore($selectedStoredSessionId)
  const root = owner === selected ? cwd : ''
  const scope = `${desktopFsCacheKey(connection)}\0${root}`

  return root ? (
    <ProjectEditor cwd={root} key={scope} scope={scope} />
  ) : (
    <div className="grid h-full place-items-center text-sm text-(--ui-text-tertiary)" role="status">
      {t.workspaceEditor.openProject}
    </div>
  )
}

interface ProjectEditorProps {
  cwd: string
  scope: string
}

export function ProjectEditor({ cwd, scope }: ProjectEditorProps) {
  const { t } = useI18n()
  const editor = useEditorDocument(scope, t.workspaceEditor.unsupported, t.preview.diskChangedTitle)
  const { file, draft, dirty, version, loading, saving, error, conflict, open, change, save } = editor
  const [refresh, setRefresh] = useState(0)
  const tick = useStore($workspaceChangeTick)
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const lifetime = useRef({ active: true, request: 0 })

  useEffect(() => {
    const state = lifetime.current
    state.active = true

    return () => {
      state.active = false
      ++state.request
    }
  }, [])

  const cancelDiff = () => {
    ++lifetime.current.request
    setDiff(null)
    setDiffError(null)
    setDiffLoading(false)
  }

  const showDiff = async (root: string, selected: HermesReviewFile) => {
    const request = ++lifetime.current.request
    const git = desktopGit()

    if (!git) {
      return
    }

    setDiffLoading(true)
    setDiffError(null)

    try {
      const text = await git.review.diff(root, selected.path, 'uncommitted', null, selected.staged)

      if (lifetime.current.active && request === lifetime.current.request) {
        setDiff({ path: selected.path, text })
      }
    } catch (cause) {
      if (lifetime.current.active && request === lifetime.current.request) {
        setDiffError(String(cause instanceof Error ? cause.message : cause))
      }
    } finally {
      if (lifetime.current.active && request === lifetime.current.request) {
        setDiffLoading(false)
      }
    }
  }

  const selectFile = (path: string) => {
    cancelDiff()
    void open(path)
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden text-(--ui-text-secondary)">
      <aside className="flex w-64 min-w-40 max-w-[40%] shrink-0 resize-x flex-col overflow-auto border-r border-(--ui-stroke-tertiary)">
        <header className="flex items-center justify-between p-2 text-sm">
          <span>{t.sidebar.files}</span>
          <Button onClick={() => setRefresh(value => value + 1)} size="sm" variant="ghost">
            {t.workspaceEditor.refresh}
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <EditorFileTree
            name={cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || cwd}
            onOpen={selectFile}
            path={cwd}
            refresh={refresh + tick}
            root
            selected={file?.path}
          />
        </div>
        <EditorChanges cwd={cwd} onDiff={(root, selected) => void showDiff(root, selected)} refresh={refresh} />
      </aside>
      <section aria-label={t.workspaceEditor.title} className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex min-h-10 items-center gap-2 border-b border-(--ui-stroke-tertiary) px-3">
          <span className="min-w-0 flex-1 truncate text-sm">
            {diff?.path ?? file?.path ?? t.workspaceEditor.selectFile}
            {dirty ? ' *' : ''}
          </span>
          {diff && file && (
            <Button onClick={cancelDiff} size="sm" variant="ghost">
              {t.preview.edit}
            </Button>
          )}
          <Button
            disabled={!dirty || loading || saving || !!diff || (!!error && !conflict)}
            onClick={() => void save()}
            size="sm"
            variant="ghost"
          >
            {t.workspaceEditor.save}
          </Button>
        </header>
        {error && (
          <div className="px-3 py-2 text-sm" role="alert">
            {error}
            {conflict && file && (
              <Button onClick={() => void open(file.path, true)} size="sm" variant="ghost">
                {t.preview.discardReload}
              </Button>
            )}
          </div>
        )}
        {diffError && (
          <div className="p-2 text-sm" role="alert">
            {diffError}
          </div>
        )}
        {(loading || diffLoading) && (
          <div className="p-2 text-sm" role="status">
            {t.sidebar.loading}
          </div>
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {diff ? (
            <FileDiffPanel
              className="h-full max-h-none rounded-none"
              diff={diff.text}
              path={diff.path}
              showLineNumbers
            />
          ) : file ? (
            <Suspense fallback={null}>
              <CodeEditor
                disabled={saving || loading}
                filePath={file.path}
                initialValue={draft}
                key={`${file.path}:${version}`}
                onChange={change}
                onSave={() => void save()}
              />
            </Suspense>
          ) : (
            <div className="grid h-full place-items-center text-sm text-(--ui-text-tertiary)">
              {t.workspaceEditor.selectFile}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
