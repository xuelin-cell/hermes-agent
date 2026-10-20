import { useEffect, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import type { HermesReadDirEntry } from '@/global'
import { useI18n } from '@/i18n'
import { readDesktopDir } from '@/lib/desktop-fs'

interface EditorFileTreeProps {
  path: string
  name: string
  onOpen: (path: string) => void
  selected?: string
  refresh: number
  root?: boolean
}

export function EditorFileTree({ path, name, onOpen, selected, refresh, root = false }: EditorFileTreeProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(root)
  const [entries, setEntries] = useState<HermesReadDirEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!open) {
      return
    }

    let active = true
    setError(null)
    void readDesktopDir(path)
      .then(result => {
        if (!active) {
          return
        }

        if (result.error) {
          setError(result.error)

          return
        }

        setEntries(
          [...result.entries]
            .filter(entry => entry.name !== '.git')
            .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
        )
      })
      .catch(cause => {
        if (active) {
          setError(String(cause instanceof Error ? cause.message : cause))
        }
      })

    return () => {
      active = false
    }
  }, [path, open, refresh, retry])

  return (
    <div>
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-sm hover:bg-(--ui-row-hover-background)"
        onClick={() => setOpen(value => !value)}
        type="button"
      >
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} />
        <Codicon name={open ? 'folder-opened' : 'folder'} />
        <span className="truncate">{name}</span>
      </button>
      {open && (
        <div className="pl-3">
          {error ? (
            <button
              className="break-all text-xs text-(--ui-text-tertiary)"
              onClick={() => setRetry(value => value + 1)}
              type="button"
            >
              {error} · {t.workspaceEditor.refresh}
            </button>
          ) : !entries ? (
            <span role="status">{t.sidebar.loading}</span>
          ) : (
            entries.map(entry =>
              entry.isDirectory ? (
                <EditorFileTree
                  key={entry.path}
                  name={entry.name}
                  onOpen={onOpen}
                  path={entry.path}
                  refresh={refresh}
                  selected={selected}
                />
              ) : (
                <button
                  aria-current={entry.path === selected ? 'true' : undefined}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-(--ui-row-hover-background) aria-current:bg-(--ui-control-active-background)"
                  key={entry.path}
                  onClick={() => onOpen(entry.path)}
                  type="button"
                >
                  <Codicon name="file" />
                  <span className="truncate">{entry.name}</span>
                </button>
              )
            )
          )}
        </div>
      )}
    </div>
  )
}
